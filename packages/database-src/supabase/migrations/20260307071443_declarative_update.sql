set check_function_bodies = off;

create type "fsm_core"."ancestor_states_result_v1" as ("ancestor_states_to_enter" text[], "ancestor_states_for_default_entry" text[]);

CREATE OR REPLACE FUNCTION fsm_core.compute_entry_actions_v1(transition_record fsm_core.fsm_transitions, fsm_name_param text, fsm_version_param text, is_initial_transition boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    sanitized_source_ltree LTREE;
    sanitized_target_ltree_array LTREE[];
    sanitized_target_state TEXT;
    transition_domain_lca ltree;
    reenter_flag BOOLEAN;
    effective_target_states_ltree_array LTREE[];
    sanitized_effective_target_state TEXT;
    ancestors TEXT[];
    ancestors_result RECORD;
    domain_type TEXT;
    child_result RECORD;
    states_to_enter TEXT[];
    states_for_default_entry TEXT[];
    common_states TEXT[] := '{}';
    state_to_check TEXT;
    entry_actions_result JSONB;
    initial_actions_for_common_states_result JSONB;
    resolve_state_value_result JSONB;
    final_result JSONB;
BEGIN

   -- if is_initial_transition true 
   -- then return empty result
    IF is_initial_transition THEN
          select fsm_core.resolve_state_value_v1('{}'::jsonb, fsm_name_param, fsm_version_param) INTO resolve_state_value_result;
        --   states_to_enter := resolve_state_value_result->'all_nodes';
          states_to_enter := array(
                SELECT jsonb_array_elements_text(resolve_state_value_result->'all_nodes')
            );

          SELECT fsm_core.get_entry_actions_v1(states_to_enter, fsm_name_param, fsm_version_param) INTO entry_actions_result;
          RETURN jsonb_build_object(
                'states_to_enter', states_to_enter,
                'states_for_default_entry', '[]'::jsonb,
                'common_states', '[]'::jsonb,
                'entry_actions_for_states_to_enter', entry_actions_result::jsonb,
                'initial_actions_for_common_states', '[]'::jsonb
          );
    END IF;
    
    -- If no transition found, return empty result
    IF transition_record IS NULL THEN
        RETURN jsonb_build_object(
            'states_to_enter', '[]'::jsonb,
            'states_for_default_entry', '[]'::jsonb,
            'common_states', '[]'::jsonb,
            'entry_actions_for_states_to_enter', '[]'::jsonb,
            'initial_actions_for_common_states', '[]'::jsonb
        );
    END IF;
    
    
    sanitized_source_ltree := transition_record.computed_sanitized_source_ltree;
   
    sanitized_target_ltree_array := transition_record.computed_sanitized_target_ltree_array;
   

    RAISE NOTICE 'Calculating Transition Domain LCA from transition_record: %', transition_record;

    transition_domain_lca := fsm_core.sql_lca_from_array(
        ARRAY[transition_record.computed_sanitized_source_ltree::ltree] || transition_record.computed_sanitized_target_ltree_array
    );

    reenter_flag := COALESCE((transition_record.reenter)::BOOLEAN, FALSE);
    
    -- Part 1 : add all target state node and call addDescendantStatesToEnter to add all inital and node childern nodes
    -- Call getStatesForEntry with the transition record and fsm parameters
    -- result := getStatesForEntry(source_state, target_states_json, transition_domain_lca::TEXT, reenter_flag, fsm_name_param, fsm_version_param);
    -- above line is and getStatesForEntry fn replaced with below code
    RAISE NOTICE 'sanitized_target_ltree_array: %', sanitized_target_ltree_array;
    IF sanitized_target_ltree_array IS NOT NULL AND array_length(sanitized_target_ltree_array, 1) > 0 THEN
        FOR sanitized_target_state IN SELECT unnest(sanitized_target_ltree_array)
        LOOP
            
            -- Apply the logic from the JavaScript code
            IF (
                -- if the target is different than the source then it will *definitely* be entered
                sanitized_source_ltree::TEXT != sanitized_target_state::TEXT OR
                -- we know that the domain can't lie within the source
                -- if it's different than the source then it's outside of it and it means that the target has to be entered as well
                sanitized_source_ltree::TEXT != transition_domain_lca::TEXT OR
                -- reentering transitions always enter the target, even if it's the source itself
                reenter_flag
            ) THEN
                
                -- Add to states_to_enter if not already present
                
                    states_to_enter := array_append(states_to_enter, sanitized_target_state);
                
                    states_for_default_entry := array_append(states_for_default_entry, sanitized_target_state);
                
                    RAISE NOTICE 'states_to_enter: %', states_to_enter;
            END IF;

            RAISE NOTICE 'Before fsm_core.get_descendant_states_for_entry_v1 for sanitized_target_state: %', sanitized_target_state;
            RAISE NOTICE 'states_to_enter: %', states_to_enter;
            RAISE NOTICE 'states_for_default_entry: %', states_for_default_entry;
            
            -- call fsm_core.get_descendant_states_for_entry_v1 for each child state
            child_result := fsm_core.get_descendant_states_for_entry_v1(sanitized_target_state::text, fsm_name_param, fsm_version_param);
            RAISE NOTICE 'After fsm_core.get_descendant_states_for_entry_v1 for sanitized_target_state: %', sanitized_target_state;
            RAISE NOTICE 'child_result: %', child_result;
            states_to_enter := array_cat(states_to_enter, child_result.descendant_states_to_enter);
            states_for_default_entry := array_cat(states_for_default_entry, child_result.descendant_states_for_default_entry);
            RAISE NOTICE 'states_to_enter: %', states_to_enter;
            RAISE NOTICE 'states_for_default_entry: %', states_for_default_entry;
        END LOOP;
    END IF;

    -- Part 2 : add all inbetween state nodes from domain to target state node

    SELECT type INTO domain_type FROM fsm_core.fsm_states
                WHERE computed_state_key_ltree = transition_domain_lca
                  AND fsm_name = fsm_name_param
                  AND fsm_version = fsm_version_param;

    -- TODO : pending fn of getEffectiveTargetStates would be transition_json -> 'target';
    effective_target_states_ltree_array = transition_record.computed_sanitized_target_ltree_array;
    RAISE NOTICE 'effective_target_states_ltree_array: %', effective_target_states_ltree_array;
    -- for (const s of effective_target_states) {
    --   const ancestors = get_proper_ancestors(s, domain);
    --   if (domain?.type === 'parallel') {
    --     ancestors.push(domain);
    --   }
    --   fsm_core.get_ancestor_states_for_entry_v1(
    --     statesToEnter,
    --     historyValue,
    --     statesForDefaultEntry,
    --     ancestors,
    --     !t.source.parent && t.reenter ? undefined : domain
    --   );
    -- }

    IF effective_target_states_ltree_array IS NOT NULL AND array_length(effective_target_states_ltree_array, 1) > 0 THEN
        FOR sanitized_effective_target_state IN SELECT unnest(effective_target_states_ltree_array)
        LOOP

            

            -- Get ancestors for s and domain
            ancestors := fsm_core.get_proper_ancestors(sanitized_effective_target_state::TEXT, transition_domain_lca::TEXT);

            -- If domain is parallel, append domain to ancestors
            IF domain_type = 'parallel' THEN
                ancestors := array_append(ancestors, transition_domain_lca::TEXT);
            END IF;

            
            ancestors_result := fsm_core.get_ancestor_states_for_entry_v1(
                ancestors,
                CASE WHEN transition_record.source IS NULL AND transition_record.reenter THEN NULL ELSE transition_domain_lca::TEXT END,
                fsm_name_param,
                fsm_version_param
            );

            states_to_enter := array_cat(states_to_enter, ancestors_result.ancestor_states_to_enter);

        END LOOP;
    END IF;

    RAISE NOTICE 'Final states_to_enter before dedup: %', states_to_enter;
    RAISE NOTICE 'Final states_for_default_entry before dedup: %', states_for_default_entry;
  
    
    -- Find common elements between states_to_enter and states_for_default_entry
    FOR state_to_check IN SELECT unnest(states_to_enter)
    LOOP
        -- Check if statesForDefaultEntry has this stateNodeToEnter
        IF state_to_check = ANY(states_for_default_entry) THEN
            -- Add to common_states (actions array equivalent)
            common_states := array_append(common_states, state_to_check);
        END IF;
    END LOOP;
    
    -- Log the common states found
    RAISE NOTICE 'Common states found: %', common_states;
        
        
  

    -- Get entry actions for states_to_enter
    SELECT fsm_core.get_entry_actions_v1(states_to_enter, fsm_name_param, fsm_version_param) INTO entry_actions_result;

    -- -- Get entry actions for states_for_default_entry
    -- SELECT fsm_core.get_entry_actions_v1(states_for_default_entry, fsm_name_param, fsm_version_param) INTO default_entry_actions_result;
    -- Get entry actions for the common states
    IF array_length(common_states, 1) > 0 THEN
        SELECT fsm_core.get_initial_actions_v1(common_states, fsm_name_param, fsm_version_param) INTO initial_actions_for_common_states_result;
    END IF;


    -- Build the final result containing both arrays and their respective actions
    final_result := jsonb_build_object(
        'states_to_enter', to_jsonb(states_to_enter),
        'states_for_default_entry', to_jsonb(states_for_default_entry),
        'common_states', to_jsonb(common_states),
        'entry_actions_for_states_to_enter', entry_actions_result,
        'initial_actions_for_common_states', initial_actions_for_common_states_result
    );

    RETURN final_result;
END;
$function$
;

create type "fsm_core"."descendant_states_result_v1" as ("descendant_states_to_enter" text[], "descendant_states_for_default_entry" text[]);

CREATE OR REPLACE FUNCTION fsm_core.get_ancestor_states_for_entry_v1(ancestors text[], reentrancy_domain text, fsm_name_param text, fsm_version_param text)
 RETURNS fsm_core.ancestor_states_result_v1
 LANGUAGE plpgsql
AS $function$
DECLARE
    ancestor_states_to_enter TEXT[] := ARRAY[]::TEXT[];
    ancestor_states_for_default_entry TEXT[] := ARRAY[]::TEXT[];
    anc TEXT;
    anc_record fsm_core.fsm_states;
    child_state JSONB;
    child_id TEXT;
    sanitized_child_id TEXT;
    sanitized_child_id_ltree LTREE;
    is_descendant BOOLEAN;
    child_result RECORD;
    i INT;
    result fsm_core.ancestor_states_result_v1;
BEGIN
    FOREACH anc IN ARRAY ancestors LOOP
        -- If no reentrancy_domain or anc is descendant of reentrancy_domain, add to ancestor_states_to_enter
        IF reentrancy_domain IS NULL OR anc::ltree <@ reentrancy_domain::ltree THEN
            IF NOT (anc = ANY(ancestor_states_to_enter)) THEN
                ancestor_states_to_enter := array_append(ancestor_states_to_enter, anc);
            END IF;
        END IF;

        -- Check if ancestor is a parallel state
        SELECT * INTO anc_record
        FROM fsm_core.fsm_states
        WHERE computed_state_key_ltree = anc::ltree
          AND fsm_name = fsm_name_param
          AND fsm_version = fsm_version_param
        LIMIT 1;

        IF anc_record.type = 'parallel' THEN
            -- For each child of the parallel state
            IF anc_record.states IS NOT NULL THEN
                FOR child_state IN SELECT value FROM jsonb_each(anc_record.states)
                LOOP
                    child_id := child_state->>'id';
                    -- Sanitize child_id
                    sanitized_child_id := sanitize_to_ltree(child_id)::TEXT;
                    SELECT computed_state_key_ltree INTO sanitized_child_id_ltree
                    FROM fsm_core.fsm_states
                    WHERE computed_state_id_ltree = sanitized_child_id::ltree;
                    -- Only add child if no state in ancestor_states_to_enter is a descendant of child
                    is_descendant := FALSE;
                    IF sanitized_child_id_ltree::TEXT IS NOT NULL THEN
                        FOR i IN 1..array_length(ancestor_states_to_enter, 1) LOOP
                            IF ancestor_states_to_enter[i]::ltree <@ sanitized_child_id_ltree::ltree THEN
                                is_descendant := TRUE;
                                EXIT;
                            END IF;
                        END LOOP;
                        IF NOT is_descendant THEN
                            ancestor_states_to_enter := array_append(ancestor_states_to_enter, sanitized_child_id_ltree::text);
                           
                           
                            -- Optionally, add descendants here if needed
                            child_result := fsm_core.get_descendant_states_for_entry_v1(sanitized_child_id_ltree::text, fsm_name_param, fsm_version_param);
                            
                            -- TODO: DIFF:: only child_result would be added in both place ancestor_states_to_enter and ancestor_states_for_default_entry 
                            ancestor_states_to_enter := array_cat(ancestor_states_to_enter, child_result.descendant_states_to_enter);
                            ancestor_states_for_default_entry := array_cat(ancestor_states_for_default_entry, child_result.descendant_states_for_default_entry);
                        END IF;
                    END IF;
                END LOOP;
            END IF;
        END IF;
    END LOOP;

    -- Remove duplicates before returning
    SELECT array_agg(DISTINCT s) INTO ancestor_states_to_enter FROM unnest(ancestor_states_to_enter) AS s;
    SELECT array_agg(DISTINCT s) INTO ancestor_states_for_default_entry FROM unnest(ancestor_states_for_default_entry) AS s;
    
    -- Prepare result
    result.ancestor_states_to_enter := COALESCE(ancestor_states_to_enter, ARRAY[]::TEXT[]);
    result.ancestor_states_for_default_entry := COALESCE(ancestor_states_for_default_entry, ARRAY[]::TEXT[]);
    
    RETURN result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.get_descendant_states_for_entry_v1(input_state_id text, fsm_name_param text, fsm_version_param text)
 RETURNS fsm_core.descendant_states_result_v1
 LANGUAGE plpgsql
AS $function$
DECLARE
    result fsm_core.descendant_states_result_v1;
    descendant_states_to_enter TEXT[] := ARRAY[]::TEXT[];
    descendant_states_for_default_entry TEXT[] := ARRAY[]::TEXT[];
    state_record fsm_core.fsm_states;
    child_states JSONB;
    child_state JSONB;
    child_id TEXT;
    sanitized_child_id TEXT;
    sanitized_child_id_ltree LTREE;
    initial_state TEXT;
    sanitized_initial_state TEXT;
    sanitized_initial_state_ltree LTREE;
    child_result fsm_core.descendant_states_result_v1;
    ancestors TEXT[];
    ancestors_result RECORD;
BEGIN
    -- Initialize result
    result.descendant_states_to_enter := ARRAY[]::TEXT[];
    result.descendant_states_for_default_entry := ARRAY[]::TEXT[];
    
    -- Get the state record from database using state_path, fsm_name, and fsm_version
    SELECT * INTO state_record
    FROM fsm_core.fsm_states 
    WHERE computed_state_key_ltree = input_state_id::LTREE 
      AND fsm_name = fsm_name_param 
      AND fsm_version = fsm_version_param;

    RAISE NOTICE 'state_record.type: %', state_record.type;
    -- If state doesn't exist, return empty arrays
    IF state_record IS NULL THEN
        RETURN result;
    END IF;
    
    -- Process based on state type
    IF state_record.type = 'compound' THEN
        -- For compound states: add initial target and recurse with it
        IF state_record.initial IS NOT NULL AND state_record.initial->'target' IS NOT NULL THEN
            initial_state := state_record.initial->'target'->>0;
            RAISE NOTICE 'Initial state: %', initial_state;
            -- Sanitize initial_state
            sanitized_initial_state := sanitize_to_ltree(initial_state)::TEXT;
            SELECT computed_state_key_ltree INTO sanitized_initial_state_ltree
            FROM fsm_core.fsm_states
            WHERE computed_state_id_ltree = sanitized_initial_state::ltree;
            
            
            -- Add sanitized initial state to both arrays
            descendant_states_to_enter := array_append(descendant_states_to_enter, sanitized_initial_state_ltree::text);
            descendant_states_for_default_entry := array_append(descendant_states_for_default_entry, sanitized_initial_state_ltree::text);
            
            -- Recursive call with sanitized initial target and merge results
            child_result := fsm_core.get_descendant_states_for_entry_v1(sanitized_initial_state_ltree::text, fsm_name_param, fsm_version_param);

            descendant_states_to_enter := array_cat(descendant_states_to_enter, child_result.descendant_states_to_enter);
            descendant_states_for_default_entry := array_cat(descendant_states_for_default_entry, child_result.descendant_states_for_default_entry);

            -- TODO: add all inbetween states nodes from target node and its' initial node
            -- addProperAncestorStatesToEnter(
            --     initialState,
            --     stateNode,
            --     statesToEnter,
            --     historyValue,
            --     statesForDefaultEntry
            -- );

            -- function addProperAncestorStatesToEnter(
            --     stateNode: AnyStateNode,
            --     toStateNode: AnyStateNode | undefined,
            --     statesToEnter: Set<AnyStateNode>,
            --     historyValue: HistoryValue<any, any>,
            --     statesForDefaultEntry: Set<AnyStateNode>
            --     ) {
            --         fsm_core.get_ancestor_states_for_entry_v1(
            --             statesToEnter,
            --             historyValue,
            --             statesForDefaultEntry,
            --             get_proper_ancestors(stateNode, toStateNode)
            --         );
            --     }

            ancestors := fsm_core.get_proper_ancestors(sanitized_initial_state_ltree::TEXT, state_record.computed_state_key_ltree::TEXT); 
            ancestors_result := fsm_core.get_ancestor_states_for_entry_v1(
                ancestors,
                NULL,
                fsm_name_param,
                fsm_version_param
            );

            -- TODO: DIFF::  for  descendant_states_to_enter and descendant_states_for_default_entry
            descendant_states_to_enter := array_cat(descendant_states_to_enter, ancestors_result.ancestor_states_to_enter);
            

        END IF;
        
    ELSIF state_record.type = 'parallel' THEN
        -- For parallel states: recurse with all child states
        child_states := state_record.states;
        
        IF child_states IS NOT NULL THEN
            FOR child_state IN SELECT value FROM jsonb_each(child_states)
            LOOP
                child_id := child_state->>'id';
                
                -- Sanitize child_id
                sanitized_child_id := sanitize_to_ltree(child_id)::TEXT;
                SELECT computed_state_key_ltree INTO sanitized_child_id_ltree
                FROM fsm_core.fsm_states
                WHERE computed_state_id_ltree = sanitized_child_id::ltree;

                -- Add sanitized child state to both arrays
                descendant_states_to_enter := array_append(descendant_states_to_enter, sanitized_child_id_ltree::text);
                descendant_states_for_default_entry := array_append(descendant_states_for_default_entry, sanitized_child_id_ltree::text);
                
                -- Recursive call with sanitized child state and merge results
                child_result := fsm_core.get_descendant_states_for_entry_v1(sanitized_child_id_ltree::text, fsm_name_param, fsm_version_param);
                descendant_states_to_enter := array_cat(descendant_states_to_enter, child_result.descendant_states_to_enter);
                descendant_states_for_default_entry := array_cat(descendant_states_for_default_entry, child_result.descendant_states_for_default_entry);
            END LOOP;
        END IF;
    ELSIF state_record.type = 'atomic' OR state_record.type = 'final' THEN
        -- For atomic, final no descendants to add
        -- DO NOTHING
        
    END IF;
   
    -- Remove duplicates from both arrays
    SELECT array_agg(DISTINCT state) INTO descendant_states_to_enter 
    FROM unnest(descendant_states_to_enter) AS state;
    
    SELECT array_agg(DISTINCT state) INTO descendant_states_for_default_entry 
    FROM unnest(descendant_states_for_default_entry) AS state;
    
    -- Set result values
    result.descendant_states_to_enter := COALESCE(descendant_states_to_enter, ARRAY[]::TEXT[]);
    result.descendant_states_for_default_entry := COALESCE(descendant_states_for_default_entry, ARRAY[]::TEXT[]);

    RAISE NOTICE 'fsm_core.get_descendant_states_for_entry_v1 result: %', result;
    RETURN result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.get_entry_actions_v1(p_state_paths text[], p_fsm_name text, p_fsm_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
    all_actions JSONB := '[]'::jsonb;
    rec RECORD;
    action JSONB;
    i INTEGER;
BEGIN
    -- Collect all actions from matching records
    FOR rec IN
        SELECT 
            COALESCE(fs.entry, '[]'::jsonb) AS entry_actions,
            COALESCE(fs.invoke, '[]'::jsonb) AS invoke_actions,
            fs.fsm_order
        FROM fsm_core.fsm_states fs
        WHERE 
            fs.computed_state_key_ltree = ANY(p_state_paths::ltree[])
            AND fs.fsm_name = p_fsm_name
            AND fs.fsm_version = p_fsm_version
        ORDER BY fs.fsm_order DESC
    LOOP
        -- Process entry actions and add to combined array
        IF jsonb_array_length(rec.entry_actions) > 0 THEN
            FOR i IN 0..jsonb_array_length(rec.entry_actions)-1 LOOP
                action := rec.entry_actions->i;
                action := action || jsonb_build_object(
                    'fsm_order', rec.fsm_order,
                    'action_type', 'entry'
                );
                all_actions := all_actions || jsonb_build_array(action);
            END LOOP;
        END IF;
        
        -- Process invoke actions and add to combined array
        IF jsonb_array_length(rec.invoke_actions) > 0 THEN
            FOR i IN 0..jsonb_array_length(rec.invoke_actions)-1 LOOP
                action := rec.invoke_actions->i;
                action := action || jsonb_build_object(
                    'fsm_order', rec.fsm_order,
                    'action_type', 'invoke'
                );
                all_actions := all_actions || jsonb_build_array(action);
            END LOOP;
        END IF;
    END LOOP;
    
    -- Return single JSON with combined actions array
    -- Actions are already sorted by fsm_order DESC due to the ORDER BY in the query
    -- RETURN jsonb_build_object('actions', all_actions);
    RETURN all_actions;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.get_initial_actions_v1(p_state_paths text[], p_fsm_name text, p_fsm_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
    all_actions JSONB := '[]'::jsonb;
    rec RECORD;
    initial_record JSONB;
    action JSONB;
    actions_array JSONB;
    i INTEGER;
BEGIN
    -- Collect all actions from matching records' initial column
    FOR rec IN
        SELECT 
            COALESCE(fs.initial, '{}'::jsonb) AS initial_data,
            fs.fsm_order,
            fs.computed_state_key_ltree
        FROM fsm_core.fsm_states fs
        WHERE 
            fs.computed_state_key_ltree = ANY(p_state_paths::ltree[])
            AND fs.fsm_name = p_fsm_name
            AND fs.fsm_version = p_fsm_version
        ORDER BY fs.fsm_order DESC
    LOOP
        initial_record := rec.initial_data;
        
        -- Check if initial_data is not empty and has actions
        IF initial_record IS NOT NULL AND initial_record != '{}'::jsonb THEN
            -- Extract actions array from initial structure
            actions_array := initial_record->'actions';
            
            -- Process actions if they exist and are not empty
            IF actions_array IS NOT NULL AND jsonb_array_length(actions_array) > 0 THEN
                FOR i IN 0..jsonb_array_length(actions_array)-1 LOOP
                    action := actions_array->i;
                    -- Add metadata to each action
                    action := action || jsonb_build_object(
                        'fsm_order', rec.fsm_order,
                        'action_type', 'initial'
                    );
                    all_actions := all_actions || jsonb_build_array(action);
                END LOOP;
            END IF;
        END IF;
    END LOOP;
    
    -- Return single JSON with combined actions array
    -- Actions are already sorted by fsm_order DESC due to the ORDER BY in the query
    -- RETURN jsonb_build_object('actions', all_actions);
    RETURN all_actions;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.test_event_transition_for_entry_v1(event_name text, fsm_name_param text, fsm_version_param text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    transition_record fsm_core.fsm_transitions;
    result JSONB;
BEGIN
    -- Find single record from fsm_core.fsm_transitions based on event_type, fsm_name, and fsm_version
    SELECT * INTO transition_record
    FROM fsm_core.fsm_transitions 
    WHERE event_type = event_name 
      AND fsm_name = fsm_name_param 
      AND fsm_version = fsm_version_param
    LIMIT 1;
    
    -- if event_name = "initialTransition_event" then set is_initial_transition = TRUE
    -- and call fsm_core.compute_entry_actions_v1 with is_initial_transition = TRUE
    -- else call with FALSE
    IF event_name = 'initialTransition_event' THEN
        SELECT fsm_core.compute_entry_actions_v1(transition_record, fsm_name_param, fsm_version_param, TRUE) INTO result;
    ELSE
        SELECT fsm_core.compute_entry_actions_v1(transition_record, fsm_name_param, fsm_version_param, FALSE) INTO result;
    END IF;


    RETURN result;
END;
$function$
;


