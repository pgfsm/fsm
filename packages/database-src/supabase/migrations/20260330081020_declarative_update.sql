set check_function_bodies = off;

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
                    sanitized_child_id := fsm_core.sanitize_text_to_ltree(child_id)::TEXT;
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

CREATE OR REPLACE FUNCTION fsm_core.get_ancestor_states_for_entry_v2(ancestors text[], reentrancy_domain text, fsm_name_param text, fsm_version_param text)
 RETURNS fsm_core.ancestor_states_result_v2
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
    result fsm_core.ancestor_states_result_v2;
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
                    sanitized_child_id := fsm_core.sanitize_text_to_ltree(child_id)::TEXT;
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
                            child_result := fsm_core.get_descendant_states_for_entry_v2(sanitized_child_id_ltree::text, fsm_name_param, fsm_version_param);
                            
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
            sanitized_initial_state := fsm_core.sanitize_text_to_ltree(initial_state)::TEXT;
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
                sanitized_child_id := fsm_core.sanitize_text_to_ltree(child_id)::TEXT;
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

CREATE OR REPLACE FUNCTION fsm_core.get_descendant_states_for_entry_v2(input_state_id text, fsm_name_param text, fsm_version_param text)
 RETURNS fsm_core.descendant_states_result_v2
 LANGUAGE plpgsql
AS $function$
DECLARE
    result fsm_core.descendant_states_result_v2;
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
    child_result fsm_core.descendant_states_result_v2;
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
            sanitized_initial_state := fsm_core.sanitize_text_to_ltree(initial_state)::TEXT;
            SELECT computed_state_key_ltree INTO sanitized_initial_state_ltree
            FROM fsm_core.fsm_states
            WHERE computed_state_id_ltree = sanitized_initial_state::ltree;
            
            
            -- Add sanitized initial state to both arrays
            descendant_states_to_enter := array_append(descendant_states_to_enter, sanitized_initial_state_ltree::text);
            descendant_states_for_default_entry := array_append(descendant_states_for_default_entry, sanitized_initial_state_ltree::text);
            
            -- Recursive call with sanitized initial target and merge results
            child_result := fsm_core.get_descendant_states_for_entry_v2(sanitized_initial_state_ltree::text, fsm_name_param, fsm_version_param);

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
            --         fsm_core.get_ancestor_states_for_entry_v2(
            --             statesToEnter,
            --             historyValue,
            --             statesForDefaultEntry,
            --             get_proper_ancestors(stateNode, toStateNode)
            --         );
            --     }

            ancestors := fsm_core.get_proper_ancestors(sanitized_initial_state_ltree::TEXT, state_record.computed_state_key_ltree::TEXT); 
            ancestors_result := fsm_core.get_ancestor_states_for_entry_v2(
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
                sanitized_child_id := fsm_core.sanitize_text_to_ltree(child_id)::TEXT;
                SELECT computed_state_key_ltree INTO sanitized_child_id_ltree
                FROM fsm_core.fsm_states
                WHERE computed_state_id_ltree = sanitized_child_id::ltree;

                -- Add sanitized child state to both arrays
                descendant_states_to_enter := array_append(descendant_states_to_enter, sanitized_child_id_ltree::text);
                descendant_states_for_default_entry := array_append(descendant_states_for_default_entry, sanitized_child_id_ltree::text);
                
                -- Recursive call with sanitized child state and merge results
                child_result := fsm_core.get_descendant_states_for_entry_v2(sanitized_child_id_ltree::text, fsm_name_param, fsm_version_param);
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

    RAISE NOTICE 'fsm_core.get_descendant_states_for_entry_v2 result: %', result;
    RETURN result;
END;
$function$
;


