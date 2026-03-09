set check_function_bodies = off;

create type "fsm_core"."ancestor_states_result_v2" as ("ancestor_states_to_enter" text[], "ancestor_states_for_default_entry" text[]);

CREATE OR REPLACE FUNCTION fsm_core.compute_child_exit_set_v2(transition_domain_lca ltree, state_node_set ltree[])
 RETURNS text[]
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
  st ltree;
  result TEXT[] := ARRAY[]::TEXT[];
BEGIN
  
  FOREACH st IN ARRAY state_node_set LOOP
    -- use ltree descendant operator: left <@ right (st <@ domain) means st is contained by domain
    IF st <@ transition_domain_lca THEN
      result := result || st::text;
    END IF;
  END LOOP;

  RETURN result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.compute_entry_actions_v2(transition_record fsm_core.fsm_transitions, fsm_name_param text, fsm_version_param text, is_initial_transition boolean)
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
          select fsm_core.resolve_state_value_v2('{}'::jsonb, fsm_name_param, fsm_version_param) INTO resolve_state_value_result;
        --   states_to_enter := resolve_state_value_result->'all_nodes';
          states_to_enter := array(
                SELECT jsonb_array_elements_text(resolve_state_value_result->'all_nodes')
            );

          SELECT fsm_core.get_entry_actions_v2(states_to_enter, fsm_name_param, fsm_version_param) INTO entry_actions_result;
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
   

    RAISE NOTICE 'Skipped Calculating Transition Domain LCA from transition_record: %', transition_record;

    RAISE NOTICE 'Fetching Transition Domain LCA from transition_record: %', transition_record;

    transition_domain_lca := transition_record.computed_transition_domain_lca;


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

            RAISE NOTICE 'Before fsm_core.get_descendant_states_for_entry_v2 for sanitized_target_state: %', sanitized_target_state;
            RAISE NOTICE 'states_to_enter: %', states_to_enter;
            RAISE NOTICE 'states_for_default_entry: %', states_for_default_entry;
            
            -- call fsm_core.get_descendant_states_for_entry_v2 for each child state
            child_result := fsm_core.get_descendant_states_for_entry_v2(sanitized_target_state::text, fsm_name_param, fsm_version_param);
            RAISE NOTICE 'After fsm_core.get_descendant_states_for_entry_v2 for sanitized_target_state: %', sanitized_target_state;
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
    --   fsm_core.get_ancestor_states_for_entry_v2(
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

            
            ancestors_result := fsm_core.get_ancestor_states_for_entry_v2(
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
    SELECT fsm_core.get_entry_actions_v2(states_to_enter, fsm_name_param, fsm_version_param) INTO entry_actions_result;

    -- -- Get entry actions for states_for_default_entry
    -- SELECT fsm_core.get_entry_actions_v2(states_for_default_entry, fsm_name_param, fsm_version_param) INTO default_entry_actions_result;
    -- Get entry actions for the common states
    IF array_length(common_states, 1) > 0 THEN
        SELECT fsm_core.get_initial_actions_v2(common_states, fsm_name_param, fsm_version_param) INTO initial_actions_for_common_states_result;
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

CREATE OR REPLACE FUNCTION fsm_core.compute_exit_actions_v2(transition_record fsm_core.fsm_transitions, p_state_node_set text[], p_fsm_name text, p_fsm_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  exit_set_result TEXT[];
  actions_result JSONB;
BEGIN

  
  -- If no transition found, return empty array
  IF transition_record IS NULL THEN
      RETURN jsonb_build_object(
              'exit_nodes', '[]'::JSONB,
              'exit_actions', '[]'::JSONB
            );
  END IF;



  RAISE NOTICE 'Transition Record: %', transition_record;
  -- Step 1: Call compute_full_exit_set function
  SELECT fsm_core.compute_full_exit_set_v2(transition_record, p_state_node_set) INTO exit_set_result;

  RAISE NOTICE 'Exit Set Result: %', exit_set_result;

  -- Step 2: Call fsm_core.get_exit_actions_v2 with the result from step 1
  SELECT fsm_core.get_exit_actions_v2(exit_set_result, p_fsm_name, p_fsm_version) INTO actions_result;

  RAISE NOTICE 'exit_actions Result: %', actions_result;

  -- Return both exit_nodes and exit_actions as a JSON object
  RETURN jsonb_build_object(
    'exit_nodes', exit_set_result,
    'exit_actions', actions_result->'actions'
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.compute_full_exit_set_v2(transition_record fsm_core.fsm_transitions, state_node_set text[])
 RETURNS text[]
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
  transition_domain_lca ltree;
  state_node_set_ltree ltree[];
  sanitized_source TEXT;
  exit_set TEXT[] := ARRAY[]::TEXT[];
  child_exit TEXT[] := ARRAY[]::TEXT[];
  combined TEXT[];
BEGIN
  IF transition_record IS NULL OR state_node_set IS NULL THEN
    RETURN ARRAY[]::TEXT[];
  END IF;


  RAISE NOTICE 'Skipped Calculating Transition Domain LCA from transition_record: %', transition_record;

  RAISE NOTICE 'Fetching Transition Domain LCA from transition_record: %', transition_record;

  transition_domain_lca := transition_record.computed_transition_domain_lca;

  state_node_set_ltree = fsm_core.sanitize_text_array_to_ltree_array(state_node_set);
  -- call child exit set using the domain text (fsm_core.compute_child_exit_set_v2 will sanitize)
  child_exit := fsm_core.compute_child_exit_set_v2(transition_domain_lca, state_node_set_ltree);

  -- sanitize source to compare with LCA in the same normalized form
  sanitized_source := transition_record.computed_sanitized_source_ltree;

  IF sanitized_source IS NOT NULL AND sanitized_source <> '' THEN
    IF transition_domain_lca IS NOT NULL THEN
      IF transition_domain_lca::TEXT = sanitized_source::TEXT THEN
        -- Only add the source_text when the transition JSON has a truthy
        -- "reenter" flag. Use COALESCE to safely cast NULL to false.
        IF COALESCE(transition_record.reenter, 'false')::boolean = true THEN
          exit_set := exit_set || sanitized_source;
        END IF;
      END IF;
    END IF;
  END IF;

  -- combine and deduplicate
  combined := exit_set || child_exit;
  SELECT array_agg(DISTINCT x) INTO combined FROM unnest(combined) AS x WHERE x IS NOT NULL;

  RETURN COALESCE(combined, ARRAY[]::TEXT[]);
END;
$function$
;

create type "fsm_core"."descendant_states_result_v2" as ("descendant_states_to_enter" text[], "descendant_states_for_default_entry" text[]);

CREATE OR REPLACE FUNCTION fsm_core.fsm_get_all_state_nodes_v2(p_state_paths text[], p_fsm_name text, p_fsm_version text)
 RETURNS text[]
 LANGUAGE plpgsql
AS $function$
DECLARE
    node_rec RECORD;
    child_rec RECORD;
    resultNodeset text[] := ARRAY[]::text[];
    initialStates text[];
    initialStateNode text;
    log_text TEXT := '';
    child_log TEXT;
    all_fsm_states fsm_core.fsm_states[];
    temp_flag BOOLEAN;
BEGIN
    RAISE NOTICE '[fsm_core.fsm_get_all_state_nodes_v2] Input state_paths: %', p_state_paths;
    
    SELECT array_agg(fsm_states ORDER BY fsm_order ASC) INTO all_fsm_states
    FROM fsm_core.fsm_states
    WHERE fsm_name = p_fsm_name AND fsm_version = p_fsm_version AND computed_state_key_ltree::text = ANY(p_state_paths);

    RAISE NOTICE '[fsm_core.fsm_get_all_state_nodes_v2] Matching fsm_core.fsm_states count: %', array_length(all_fsm_states, 1);

    FOR node_rec IN
        SELECT * FROM unnest(all_fsm_states) AS fsm_states
    LOOP
        log_text := log_text || format(E'\nProcessing node: %s (type=%s)', node_rec.computed_state_key_ltree, node_rec.type);
        RAISE NOTICE 'Processing node: % (type=%)', node_rec.computed_state_key_ltree, node_rec.type;
        IF node_rec.type = 'compound' THEN

            
            -- Check if node_rec.computed_state_key_ltree is immediate parent of any node in p_state_paths
            -- iterate through p_state_paths and check if any path has node_rec.computed_state_key_ltree as prefix (immediate parent)
            
            temp_flag := true;

            FOR child_rec IN SELECT * FROM unnest(all_fsm_states) AS fsm_states LOOP

                RAISE NOTICE 'Checking if node % is immediate parent of path %', node_rec.computed_state_key_ltree, child_rec.computed_state_key_ltree;
                IF node_rec.computed_state_key_ltree::text = child_rec.parent_node::text THEN
                    RAISE NOTICE 'Node % is immediate parent of path % so skipping its initial states...', node_rec.computed_state_key_ltree, child_rec.computed_state_key_ltree;
                    temp_flag := FALSE;
                    EXIT; -- No need to check further
                END IF;
            END LOOP;


            IF temp_flag THEN
                RAISE NOTICE 'Compound node % is not immediate parent of any path, adding initial states with ancestors...', node_rec.computed_state_key_ltree;
                initialStates := fsm_core.fsm_get_initial_state_nodes_with_ancestors_v2(p_fsm_name, p_fsm_version, node_rec.computed_state_key_ltree::ltree);
               
                RAISE NOTICE 'Initial states with ancestors for node %: %', node_rec.computed_state_key_ltree, initialStates;
                IF initialStates IS NOT NULL THEN
                    FOREACH initialStateNode IN ARRAY initialStates LOOP
                        IF initialStateNode IS NOT NULL AND NOT (initialStateNode = ANY(resultNodeset)) THEN
                            resultNodeset := array_append(resultNodeset, initialStateNode);
                            RAISE NOTICE 'Added initialStateNode: %', initialStateNode;
                           
                        END IF;
                    END LOOP;
                END IF;
            END IF;    
        ELSIF node_rec.type = 'parallel' THEN
            
            RAISE NOTICE 'Parallel node % found, iterating children...', node_rec.computed_state_key_ltree;
            IF node_rec.states IS NOT NULL THEN
                FOR child_rec IN SELECT value FROM jsonb_each(node_rec.states) LOOP
                    RAISE NOTICE 'Processing child node in parallel state: %', child_rec.value->>'id';
                    
                    initialStates := fsm_core.fsm_get_initial_state_nodes_with_ancestors_v2(p_fsm_name, p_fsm_version, fsm_core.sanitize_text_to_ltree(child_rec.value->>'id'));
                    RAISE NOTICE 'Initial states with ancestors for child node %: %', child_rec.value->>'id', initialStates;
                    
                    IF initialStates IS NOT NULL THEN
                        FOREACH initialStateNode IN ARRAY initialStates LOOP
                            IF initialStateNode IS NOT NULL AND NOT (initialStateNode = ANY(resultNodeset)) THEN
                                resultNodeset := array_append(resultNodeset, initialStateNode);
                                RAISE NOTICE 'Added child initialStateNode: %', initialStateNode;
                            END IF;
                        END LOOP;
                    END IF;
                END LOOP;
            END IF;
        ELSEIF node_rec.type = 'atomic' THEN
            
            RAISE NOTICE 'Atomic node % found, adding to resultNodeset...', node_rec.computed_state_key_ltree;
            resultNodeset := array_append(resultNodeset, node_rec.computed_state_key_ltree::text);
            
            RAISE NOTICE 'Added atomic node: %', node_rec.computed_state_key_ltree::text;
        ELSE
            log_text := log_text || E'\n  Node type is final/history or unknown, skipping it.';
            
        
        END IF;
    END LOOP;

   
    RAISE NOTICE '[fsm_core.fsm_get_all_state_nodes_v2] Log:%', log_text;
    RAISE NOTICE '[fsm_core.fsm_get_all_state_nodes_v2] ResultNodeset: %', resultNodeset;
    RETURN COALESCE(resultNodeset, ARRAY[]::text[]);
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.fsm_get_initial_state_nodes_v2(p_fsm_name text, p_fsm_version text, p_state_path ltree)
 RETURNS text[]
 LANGUAGE plpgsql
AS $function$
DECLARE
    results text[];
BEGIN
    WITH RECURSIVE traverse(node_path) AS (
        -- Base case
        SELECT p_state_path

        UNION ALL

        -- Recursive step: handle compound and parallel in one recursive query
        SELECT
            CASE
                WHEN s.type = 'compound'
                     AND s.initial->'target'->>0 IS NOT NULL
                THEN fsm_core.sanitize_text_to_ltree(s.initial->'target'->>0)::ltree

                WHEN s.type = 'parallel'
                     AND s.states IS NOT NULL
                THEN (t.node_path::text || '.' || fsm_core.sanitize_text_to_ltree(c.value->>'key')::text)::ltree

                ELSE NULL
            END AS next_path
        FROM traverse t
        JOIN fsm_core.fsm_states s
          ON s.computed_state_key_ltree = t.node_path
         AND s.fsm_name = p_fsm_name
         AND s.fsm_version = p_fsm_version
        LEFT JOIN LATERAL jsonb_each(s.states) c
          ON s.type = 'parallel'
        WHERE (s.type = 'compound' AND s.initial->'target'->>0 IS NOT NULL)
           OR (s.type = 'parallel' AND s.states IS NOT NULL)
    )
    SELECT array_agg(DISTINCT node_path::text)
    INTO results
    FROM traverse
    WHERE node_path IS NOT NULL;

    RETURN results;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.fsm_get_initial_state_nodes_with_ancestors_v2(p_fsm_name text, p_fsm_version text, p_state_path ltree)
 RETURNS text[]
 LANGUAGE plpgsql
AS $function$
DECLARE
    initial_nodes text[];
    all_nodes text[] := ARRAY[]::text[];
    node text;
    ancestors text[];
BEGIN
    -- Get initial state nodes
    initial_nodes := fsm_core.fsm_get_initial_state_nodes_v2(p_fsm_name, p_fsm_version, p_state_path);

    -- Add initial nodes to result
    IF initial_nodes IS NOT NULL THEN
        all_nodes := initial_nodes;
        -- For each initial node, add its proper ancestors up to p_state_path
        FOREACH node IN ARRAY initial_nodes LOOP
            ancestors := fsm_core.get_proper_ancestors(node, p_state_path::text);
            IF ancestors IS NOT NULL THEN
                all_nodes := all_nodes || ancestors;
            END IF;
        END LOOP;
    END IF;

    -- Remove duplicates
    SELECT array_agg(DISTINCT n) INTO all_nodes FROM unnest(all_nodes) AS n;

    RETURN COALESCE(all_nodes, ARRAY[]::text[]);
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.fsm_worker_v2(event_name text, p_state_value jsonb, fsm_name_param text, fsm_version_param text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
	resolve_state_value_result JSONB;
	state_node_set TEXT[];
	
	macrostep_result JSONB;
BEGIN
	RAISE NOTICE 'fsm_core.fsm_worker_v2 called with event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;

	
	-- in Actual Language, single SQL function like get_fsm_data_and_resolve_state_value can be called which internally calls get_fsm_data and resolve_state_value, here we are calling resolve_state_value directly for simplicity
	-- assume p_state_value value would be drived from get_fsm_data function which fetches the current state value from database based on fsm_name and fsm_version, and then resolve_state_value function resolves it to get the set of active state nodes
	select fsm_core.resolve_state_value_v2(p_state_value::jsonb, fsm_name_param, fsm_version_param) INTO resolve_state_value_result;

	RAISE NOTICE 'resolve_state_value_result: %', resolve_state_value_result;
	state_node_set := array(
		SELECT jsonb_array_elements_text(resolve_state_value_result->'all_nodes')
	);
	
	RAISE NOTICE 'state_node_set: %', state_node_set;

	
	-- Call fsm_core.macrostep_v2 and return its JSONB result
	macrostep_result := fsm_core.macrostep_v2(
		event_name,
		state_node_set,
		fsm_name_param,
		fsm_version_param
	);

	RAISE NOTICE 'fsm_core.macrostep_v2: %', macrostep_result;

	-- call archive_event_from_fsm_type_worker with right Data

	RETURN macrostep_result;
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
            sanitized_initial_state := sanitize_to_ltree(initial_state)::TEXT;
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
                sanitized_child_id := sanitize_to_ltree(child_id)::TEXT;
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

CREATE OR REPLACE FUNCTION fsm_core.get_entry_actions_v2(p_state_paths text[], p_fsm_name text, p_fsm_version text)
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

CREATE OR REPLACE FUNCTION fsm_core.get_exit_actions_v2(p_state_paths text[], p_fsm_name text, p_fsm_version text)
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
            COALESCE(fs.exit, '[]'::jsonb) AS exit_actions,
            COALESCE(fs.invoke, '[]'::jsonb) AS invoke_actions,
            fs.fsm_order
        FROM fsm_core.fsm_states fs
        WHERE 
            -- p_state_paths should be always matched from computed_state_key_ltree column
            fs.computed_state_key_ltree = ANY(p_state_paths::ltree[])
            AND fs.fsm_name = p_fsm_name
            AND fs.fsm_version = p_fsm_version
        ORDER BY fs.fsm_order DESC
    LOOP
        -- Process exit actions and add to combined array
        IF jsonb_array_length(rec.exit_actions) > 0 THEN
            FOR i IN 0..jsonb_array_length(rec.exit_actions)-1 LOOP
                action := rec.exit_actions->i;
                action := action || jsonb_build_object(
                    'fsm_order', rec.fsm_order,
                    'action_type', 'exit'
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
    RETURN jsonb_build_object('actions', all_actions);
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.get_initial_actions_v2(p_state_paths text[], p_fsm_name text, p_fsm_version text)
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

CREATE OR REPLACE FUNCTION fsm_core.load_fsm_state_from_json_v2(json_input jsonb, root_node_text text, input_fsm_name text, input_fsm_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    state_key TEXT;
    state_key_ltree LTREE;
    state_id TEXT;
    state_id_ltree LTREE;
    state_obj JSONB;
    root_key TEXT;
    prefix TEXT := input_fsm_name || '.' || input_fsm_version;
    total_calls INTEGER := 0; -- aggregate count of calls including recursion
    child_result JSONB;
    child_calls INTEGER;
    child_ok BOOLEAN;
BEGIN
    total_calls := 1; -- this invocation

    state_id_ltree := fsm_core.sanitize_text_to_ltree(json_input->>'id');
    state_key_ltree := fsm_core.sanitize_text_to_ltree(json_input->>'key');

    IF root_node_text IS NOT NULL THEN
        root_key := root_node_text || '.' || state_key_ltree::TEXT;
    ELSE
        root_key := state_key_ltree::TEXT;
    END IF;

    RAISE NOTICE 'Inserting state with root_key: %', root_key;

    -- 1. Insert root state with all columns
    INSERT INTO fsm_core.fsm_states (
        state_id_with_fsm_name_and_fsm_version, computed_state_id_ltree, computed_state_key_ltree, id, key, parent_node, type, description, fsm_order, context, states, initial, fsm_on, transitions, entry, exit, invoke, data, history, fsm_version, fsm_name
    ) VALUES (
        -- TODO: state_id_with_fsm_name_and_fsm_version can be combined with prefix.  root_key OR state_id_ltree
        -- (prefix || '.' || root_key)::ltree,
        prefix || '.' || state_id_ltree::TEXT,
        (state_id_ltree)::ltree,
        (root_key)::ltree,
        json_input->>'id',
        json_input->>'key',
        root_node_text, -- parent_node
        (json_input->>'type')::fsm_core.fsm_state_type,
        json_input->>'description',
        (json_input->>'order')::INTEGER,
        json_input->'context',
        json_input->'states',
        json_input->'initial',
        json_input->'on',
        json_input->'transitions',
        json_input->'entry',
        json_input->'exit',
        json_input->'invoke',
        json_input->'data',
        json_input->>'history',
        input_fsm_version,
        input_fsm_name
    )
    ON CONFLICT DO NOTHING;

    RAISE NOTICE 'invoke value: %', json_input->'invoke';

    -- 2. check for all invokes (assume invoke is always an array)
    IF json_input::jsonb ? 'invoke' THEN
        DECLARE
            inv_item JSONB;
            child_count INTEGER;
        BEGIN
            FOR inv_item IN SELECT value FROM jsonb_array_elements(json_input->'invoke')
            LOOP
                RAISE NOTICE 'Processing invoke item: %', inv_item;

                IF inv_item IS NOT NULL AND inv_item->>'fsmType' = 'fsm' THEN
                    RAISE NOTICE 'Found fsm invoke: %', inv_item;
                    -- Check if src (child FSM name) and fsmVersion exists
                    IF (inv_item->>'src') IS NOT NULL AND (inv_item->>'fsmVersion') IS NOT NULL THEN

                        SELECT COUNT(*) INTO child_count
                        FROM fsm_core.fsm_states
                        WHERE fsm_name = inv_item->>'src'
                        AND fsm_version = inv_item->>'fsmVersion';

                        IF child_count = 0 THEN -- NOT FOUND
                            RAISE EXCEPTION 'Child FSM not found in fsm_core.fsm_states: %, %', inv_item->>'src', inv_item->>'fsmVersion';
                        ELSE
                            RAISE NOTICE 'Child FSM found in fsm_core.fsm_states: %, % (count=%)', inv_item->>'src', inv_item->>'fsmVersion', child_count;
                        END IF;
                    ELSE
                        RAISE WARNING 'Missing src or fsmVersion in invoke item: %', inv_item;
                    END IF;
                END IF;

            END LOOP;
        END;
    ELSE
        RAISE NOTICE 'No invoke property present';
    END IF;

    -- 3. Insert all nested states with all columns and their transitions
    FOR state_key, state_obj IN
        SELECT key, value
        FROM jsonb_each(json_input->'states')
    LOOP
        -- Only call recursively if state_obj is not null
        IF state_obj IS NOT NULL THEN
            RAISE NOTICE 'Inserting nested state key: % and root_key: %', state_obj->>'id', root_key;
            -- Call recursively and capture result to aggregate counts and propagate errors
            child_result := fsm_core.load_fsm_state_from_json_v2(state_obj, root_key, input_fsm_name, input_fsm_version);
            -- If child_result is null (should not happen), raise an exception
            IF child_result IS NULL THEN
                RAISE EXCEPTION 'Child loader returned NULL for nested state % under %', state_obj->>'id', root_key;
            END IF;

            -- Extract child's calls and ok
            child_ok := COALESCE((child_result->>'ok')::BOOLEAN, false);
            child_calls := COALESCE((child_result->>'fsm_core.fsm_states_count')::INTEGER, 0);
            total_calls := total_calls + child_calls;

            IF NOT child_ok THEN
                -- Re-raise child error as an exception to propagate upward
                RAISE EXCEPTION 'Child loader error for nested state % under %: %', state_obj->>'id', root_key, COALESCE(child_result->>'error', child_result::TEXT);
            END IF;
        ELSE
            RAISE NOTICE 'Skipping state due to missing required fields: %', state_obj;
        END IF;
    END LOOP;

    -- Success: return ok true and count
    RETURN jsonb_build_object('ok', to_jsonb(true), 'fsm_core.fsm_states_count', to_jsonb(total_calls));

END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.load_fsm_transition_from_json_v2(json_input jsonb, root_node_text text, fsm_name text, fsm_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    state_key TEXT;
    state_key_ltree LTREE;
    state_id TEXT;
    state_id_ltree LTREE;
    state_obj JSONB;
    transition JSONB;
    transition_array JSONB[];
    source TEXT;
    sanitized_source LTREE;
    sanitized_source_ltree LTREE;
    target_array TEXT[];
    sanitized_target_array LTREE[];
    sanitized_target_ltree_array LTREE[];
    event_type TEXT;
    actions JSONB;
    cond JSONB;
    reenter BOOLEAN;
    transition_domain_lca ltree;
    root_key TEXT;
    prefix TEXT := fsm_name || '.' || fsm_version;
    total_calls INTEGER := 0;
    child_result JSONB;
    child_calls INTEGER;
    child_ok BOOLEAN;
BEGIN
    
    total_calls := 1; -- this invocation
    state_id_ltree := fsm_core.sanitize_text_to_ltree(json_input->>'id');
    state_key_ltree := fsm_core.sanitize_text_to_ltree(json_input->>'key');

    IF root_node_text IS NOT NULL THEN
        root_key := root_node_text || '.' || state_key_ltree::TEXT;
    ELSE
        root_key := state_key_ltree::TEXT;
    END IF;


    RAISE NOTICE 'Inserting state with root_key: %', root_key;


    -- 1. Top-level transitions
    IF json_input::jsonb ? 'transitions' THEN
        SELECT ARRAY_AGG(value) INTO transition_array
        FROM jsonb_array_elements(json_input->'transitions');

        IF transition_array IS NOT NULL THEN
            FOREACH transition IN ARRAY transition_array
                LOOP
                    -- Clean source
                    source := transition->>'source';
                    -- TODO:TBD:: fsm_core.sanitize_text_to_ltree or remove_hashtag_from_text
                    RAISE NOTICE 'sanitized source by using fsm_core.sanitize_text_to_ltree or remove_hashtag_from_text';
                    sanitized_source := fsm_core.sanitize_text_to_ltree(source);

                    SELECT computed_state_key_ltree INTO sanitized_source_ltree
                    FROM fsm_core.fsm_states
                    WHERE computed_state_id_ltree = sanitized_source;
                    RAISE NOTICE 'sanitized_source_ltree: %', sanitized_source_ltree;

                    SELECT ARRAY(
                            SELECT jsonb_array_elements_text(transition->'target')
                    ) INTO target_array;

                    RAISE NOTICE 'target_array: %', target_array;
                    -- Sanitize target array
                    IF target_array IS NULL THEN
                        sanitized_target_array := ARRAY[]::ltree[];
                    ELSE
                        sanitized_target_array := fsm_core.sanitize_text_array_to_ltree_array(target_array);
                    END IF;


                    SELECT ARRAY(
                            SELECT computed_state_key_ltree
                            FROM fsm_core.fsm_states
                            WHERE computed_state_id_ltree = ANY(sanitized_target_array)
                    ) INTO sanitized_target_ltree_array;

                    RAISE NOTICE 'sanitized_target_array: %', sanitized_target_ltree_array;

                    event_type := transition->>'eventType';
                    -- Get actions and cond
                    actions := transition->'actions';
                    cond := transition->'cond';

                    -- Get reenter flag (may be null)
                    IF (transition::jsonb ? 'reenter') THEN
                        reenter := (transition->>'reenter')::boolean;
                    ELSE
                        reenter := NULL;
                    END IF;
    
                    -- Use already sanitized target array in transition_domain_lca in v2
                    transition_domain_lca := fsm_core.sql_lca_from_array(
                        ARRAY[sanitized_source_ltree::ltree] || sanitized_target_ltree_array
                    );

                    RAISE NOTICE 'transition_domain_lca: %', transition_domain_lca;
                    -- If LCA calculation returned NULL, fall back to the root label of source (first path element)
                    IF transition_domain_lca::TEXT IS NULL THEN
                        BEGIN
                            -- subpath(...,0,1) returns the root/top-most label of the ltree
                            transition_domain_lca := subpath(sanitized_source_ltree, 0, 1);
                            RAISE NOTICE 'Fallback transition_domain_lca with subpath %', transition_domain_lca;
                        EXCEPTION WHEN OTHERS THEN
                            -- leave as NULL if source isn't a valid ltree
                            RAISE NOTICE 'Error in fallback transition_domain_lca calculation: %', SQLERRM;
                            transition_domain_lca := NULL;
                        END;
                    END IF;

                    INSERT INTO fsm_core.fsm_transitions (
                        source, computed_sanitized_source_ltree, target, computed_sanitized_target_ltree_array, event_type, actions, cond, computed_transition_domain_lca,
                                            reenter, fsm_name, fsm_version
                    )
                                    VALUES (source, sanitized_source_ltree, target_array, sanitized_target_ltree_array, event_type, actions, cond, transition_domain_lca, reenter, fsm_name, fsm_version);
                
                    RAISE NOTICE 'Inserted top-level transition: source=%, target=%, event_type=%', source, target_array, event_type;  
                
            END LOOP;
        END IF;
    END IF;

    -- 3. Insert all nested states with all columns and their transitions
    FOR state_key, state_obj IN
        SELECT key, value
        FROM jsonb_each(json_input->'states')
    LOOP
        -- Only call recursively if state_obj is not null and has required fields
        -- IF state_obj IS NOT NULL AND state_obj->>'id' IS NOT NULL AND state_obj->>'key' IS NOT NULL AND state_obj->>'type' IS NOT NULL THEN
        IF state_obj IS NOT NULL THEN
            RAISE NOTICE 'Inserting nested state key: % and root_key: %', state_obj->>'id', root_key;
            -- Call recursively and capture result to aggregate counts and propagate errors
            child_result := fsm_core.load_fsm_transition_from_json_v2(state_obj, root_key, fsm_name, fsm_version);
            IF child_result IS NULL THEN
                RAISE EXCEPTION 'Child transition loader returned NULL for nested state % under %', state_obj->>'id', root_key;
            END IF;

            child_ok := COALESCE((child_result->>'ok')::BOOLEAN, false);
            child_calls := COALESCE((child_result->>'fsm_core.fsm_transitions_count')::INTEGER, 0);
            total_calls := total_calls + child_calls;

            IF NOT child_ok THEN
                RAISE EXCEPTION 'Child transition loader error for nested state % under %: %', state_obj->>'id', root_key, COALESCE(child_result->>'error', child_result::TEXT);
            END IF;
        ELSE
            RAISE NOTICE 'Skipping state due to missing required fields: %', state_obj;
        END IF;
    END LOOP;

    -- Success: return ok true and count
    RETURN jsonb_build_object('ok', to_jsonb(true), 'fsm_core.fsm_transitions_count', to_jsonb(total_calls));

END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.macrostep_v2(event_name text, p_state_value text[], fsm_name_param text, fsm_version_param text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
	
	transition_record fsm_core.fsm_transitions;
    all_transition_records fsm_core.fsm_transitions[];
	guard_eval_transition_records fsm_core.fsm_transitions[];
	
	microstep_result JSONB;
BEGIN
	RAISE NOTICE 'fsm_core.macrostep_v2 called with event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;

	IF event_name = 'initialTransition_event' THEN
		RAISE NOTICE 'Initial transition event, skipping fsm_core.select_all_transitions_v2 and guard evaluation, directly calling fsm_core.microstep_v2 with empty transition_record';
		transition_record := NULL; -- or you can create a dummy transition_record with necessary fields for initial transition
	ELSE
		RAISE NOTICE 'Non-initial transition event, selecting all transitions and performing guard evaluation';
		SELECT array_agg(t) INTO all_transition_records
		FROM (
			SELECT (jsonb_populate_record(NULL::fsm_core.fsm_transitions, elem))::fsm_core.fsm_transitions AS t
			FROM jsonb_array_elements(fsm_core.select_all_transitions_v2(event_name, p_state_value, fsm_name_param, fsm_version_param)) elem
		) sub;

		RAISE NOTICE 'Number of transition_records found: %', array_length(all_transition_records, 1);

		IF all_transition_records IS NULL OR array_length(all_transition_records, 1) IS NULL THEN
			
			RAISE EXCEPTION 'No valid transitions found for event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;
		
		ELSIF array_length(all_transition_records, 1) > 1 THEN
			
			RAISE NOTICE 'Number of transition_records found: %', array_length(all_transition_records, 1);
			
			-- method 1: temp solution
			-- RAISE NOTICE 'SKIP : Evaluating guard : Selecting the first transition_record without guard evaluation for fsm_core.microstep_v2, this is a temporary solution and should be replaced with proper guard evaluation and conflict resolution strategy';  
			-- transition_record := all_transition_records[1];

			-- method 2: call Evaluate guard conditions again in SQL to find the valid transition record, if multiple records are still valid after evaluation, raise exception
			RAISE NOTICE 'RUN : Evaluating guard : conditions for all transition_records in SQL to find the valid transition record';
			SELECT array_agg(t) INTO guard_eval_transition_records
				FROM fsm_core.select_transitions_with_guard_eval_v2(all_transition_records) t;

			RAISE NOTICE 'Number of transition_records after guard evaluation: %', array_length(guard_eval_transition_records, 1);
			IF guard_eval_transition_records IS NULL OR array_length(guard_eval_transition_records, 1) IS NULL THEN
				RAISE EXCEPTION 'No valid transitions found after guard evaluation for event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;
			ELSIF array_length(guard_eval_transition_records, 1) > 1 THEN
				RAISE NOTICE 'removeConflictingTransitions needed to resolve multiple transitions after guard evaluation for event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;
				-- In real implementation, we should have a conflict resolution strategy to select one transition record among multiple valid records, here we are just raising exception for demonstration purpose

				
				RAISE EXCEPTION 'Multiple valid transitions found after guard evaluation for event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;
			ELSIF array_length(guard_eval_transition_records, 1) = 1 THEN
				RAISE NOTICE 'One transition_record found after guard evaluation, selecting it for fsm_core.microstep_v2';
				transition_record := guard_eval_transition_records[1];
				RAISE NOTICE 'Selected transition_record: %', transition_record;

			END IF;

		ELSIF array_length(all_transition_records, 1) = 1 THEN

			RAISE NOTICE 'One transition_record found, selecting it for fsm_core.microstep_v2';
			transition_record := all_transition_records[1];
			RAISE NOTICE 'Selected transition_record: %', transition_record;	

		END IF;

		

	END IF;
	

	-- Call fsm_core.microstep_v2 and return its JSONB result
	microstep_result := fsm_core.microstep_v2(
		transition_record,
		event_name,
		p_state_value,
		fsm_name_param,
		fsm_version_param
	);

	RAISE NOTICE 'microstep_result: %', microstep_result;

	RETURN microstep_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.microstep_v2(transition_record fsm_core.fsm_transitions, event_name text, state_value_node_set text[], fsm_name_param text, fsm_version_param text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
	
	transition_actions JSONB;
	exit_result JSONB;
	entry_result JSONB;
	exit_nodes TEXT[];
	entry_nodes TEXT[];
	updated_state_nodes TEXT[];
	updated_state_nodes_jsonb JSONB;
	exit_actions JSONB;
	entry_actions JSONB;
	initial_actions JSONB;
	result JSONB;
BEGIN
	RAISE NOTICE 'fsm_core.microstep_v2 called with event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;
	
	RAISE NOTICE 'state_value_node_set: %', state_value_node_set;


	-- 1. Call processEventTransitionForExit
	exit_result := fsm_core.compute_exit_actions_v2(transition_record, state_value_node_set, transition_record.fsm_name, transition_record.fsm_version);
	RAISE NOTICE 'exit_result: %', exit_result;
	SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[]) INTO exit_nodes
	FROM jsonb_array_elements_text(COALESCE(exit_result->'exit_nodes', '[]'::jsonb));
	RAISE NOTICE 'exit_nodes: %', exit_nodes;


	-- 2. transition_actions
	transition_actions := transition_record.actions;
	RAISE NOTICE 'transition_actions: %', transition_actions; 

	-- 3. Call fsm_core.compute_entry_actions_v2
	-- if event is initialTransition_event, set is_initial_transition to TRUE
	IF event_name = 'initialTransition_event' THEN
		entry_result := fsm_core.compute_entry_actions_v2(transition_record, fsm_name_param, fsm_version_param, TRUE);
	ELSE
		entry_result := fsm_core.compute_entry_actions_v2(transition_record, fsm_name_param, fsm_version_param, FALSE);
	END IF;
	RAISE NOTICE 'entry_result: %', entry_result;
	SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[]) INTO entry_nodes
	FROM jsonb_array_elements_text(COALESCE(entry_result->'states_to_enter', '[]'::jsonb));
	RAISE NOTICE 'entry_nodes: %', entry_nodes;
	

	-- 4. Compute updated state node set:
	--    (state_value_node_set - exit_nodes) + entry_nodes
	updated_state_nodes := ARRAY(
		SELECT DISTINCT x FROM (
			SELECT unnest(state_value_node_set) AS x
			EXCEPT
			SELECT unnest(exit_nodes) AS x
			UNION
			SELECT unnest(entry_nodes) AS x
		) t
	);
	RAISE NOTICE 'updated_state_nodes: %', updated_state_nodes;

	
	updated_state_nodes_jsonb := fsm_core.build_nested_json_recursive(updated_state_nodes);
	RAISE NOTICE 'updated_state_nodes_jsonb: %', updated_state_nodes_jsonb;

	-- 5. Return result as JSONB
	result := jsonb_build_object(
		'updated_state_value_node_set', updated_state_nodes,
		'updated_state_value', updated_state_nodes_jsonb,
		'exit_actions', exit_result->'exit_actions',
		'entry_actions', entry_result->'entry_actions_for_states_to_enter',
		'initial_actions', entry_result->'initial_actions_for_common_states',
		'transition_actions', transition_actions
	);
	RAISE NOTICE 'fsm_core.microstep_v2 result: %', result;
	RETURN result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.resolve_state_value_v2(input_json jsonb, input_fsm_name text, input_fsm_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    root_node text;
    all_paths TEXT[];
    all_nodes TEXT[];
    nested_json JSONB;
    result_json JSONB;
    all_fsm_states fsm_core.fsm_states[];
    root_node_record fsm_core.fsm_states;
BEGIN
    -- Get root node for fsm_name and fsm_version (lowest fsm_order)
    -- SELECT computed_state_key_ltree INTO root_node
    -- FROM fsm_core.fsm_states
    -- WHERE fsm_name = input_fsm_name AND fsm_version = input_fsm_version
    -- ORDER BY fsm_order ASC
    -- LIMIT 1;

    -- RAISE NOTICE 'Root node: %', root_node;

    SELECT array_agg(fsm_states ORDER BY fsm_order ASC) INTO all_fsm_states
    FROM fsm_core.fsm_states
    WHERE fsm_name = input_fsm_name AND fsm_version = input_fsm_version;

    root_node_record := all_fsm_states[1]; -- Get the first record (lowest fsm_order) 
    
    root_node := root_node_record.computed_state_key_ltree::text; -- Extract the computed_state_key_ltree as text

    RAISE NOTICE 'Root node: %', root_node;

    -- Get all paths from the JSONB object, using root_node as prefix if found
    IF root_node IS NOT NULL THEN
        RAISE NOTICE 'Using root_node as prefix for jsonb_all_paths';
        all_paths := fsm_core.jsonb_all_paths(input_json, root_node);
    ELSE
        all_paths := fsm_core.jsonb_all_paths(input_json, '');
    END IF;

    RAISE NOTICE 'All paths: %', all_paths;
    -- Get all state nodes for these paths
    all_nodes := fsm_core.fsm_get_all_state_nodes_v2(all_paths, input_fsm_name, input_fsm_version);

    RAISE NOTICE 'All nodes after fsm_core.fsm_get_all_state_nodes_v2: %', all_nodes;
    -- Build nested JSON from the state nodes
    nested_json := fsm_core.build_nested_json_recursive(all_nodes);

    RAISE NOTICE 'Nested JSON: %', nested_json;

    -- Build a result object that contains both the nested JSON and the list of all nodes
    result_json := jsonb_build_object(
        'json', COALESCE(nested_json, '{}'::jsonb),
        'all_nodes', COALESCE(to_jsonb(all_nodes), '[]'::jsonb)
    );

    RAISE NOTICE 'Result JSON (json + all_nodes): %', result_json;

    RETURN result_json;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.select_all_transitions_v2(event_name text, p_state_value text[], fsm_name_param text, fsm_version_param text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
	transitions JSONB;
BEGIN
	transitions := (
		SELECT jsonb_agg(t)
		FROM (
			SELECT * FROM fsm_core.fsm_transitions
			WHERE event_type = event_name
			  AND computed_sanitized_source_ltree::text = ANY(p_state_value)
			  AND fsm_name = fsm_name_param
			  AND fsm_version = fsm_version_param
		) t
	);
	IF transitions IS NULL THEN
		transitions := '[]'::jsonb;
	END IF;
	RETURN transitions;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.select_transitions_with_guard_eval_v2(input_all_transitions fsm_core.fsm_transitions[])
 RETURNS SETOF fsm_core.fsm_transitions
 LANGUAGE plpgsql
AS $function$
DECLARE
	transition_record fsm_core.fsm_transitions;
	guard_value BOOLEAN;
BEGIN

	RAISE NOTICE 'fsm_core.select_transitions_with_guard_eval_v2 called with input_all_transitions: %', input_all_transitions;
	FOR transition_record IN SELECT * FROM unnest(input_all_transitions) LOOP
		-- Default guard to TRUE when no cond provided
		guard_value := TRUE;

		IF transition_record.cond IS NOT NULL THEN
			RAISE NOTICE 'Evaluating guard condition and guard condition value: %', transition_record.cond;
			-- If cond has a 'type' field, call the named SQL function and pass cond->>'param' as JSONB
			IF transition_record.cond ? 'type' THEN
				RAISE NOTICE 'Calling guard function: % with param: %', transition_record.cond->>'type', transition_record.cond->>'param';

				EXECUTE 'SELECT ' || quote_ident(transition_record.cond->>'type') || '($1)'
				INTO guard_value
				USING (transition_record.cond->>'param')::JSONB;
				RAISE NOTICE 'Guard function result: %', guard_value;
			ELSE
				RAISE NOTICE 'Evaluating guard condition without function and guard condition value: %', transition_record.cond;
				-- Try common shapes: check for 'value' or 'predicate' keys, else if cond is boolean JSONB
				IF transition_record.cond ? 'value' THEN
					guard_value := COALESCE((transition_record.cond->>'value')::BOOLEAN, TRUE);
				-- ELSIF transition_record.cond ? 'predicate' THEN
				-- 	guard_value := COALESCE((transition_record.cond->>'predicate')::BOOLEAN, TRUE);
				ELSIF jsonb_typeof(transition_record.cond) = 'boolean' THEN
					-- cond is a bare boolean JSON value (true/false)
					guard_value := (transition_record.cond::TEXT)::BOOLEAN;
					RAISE NOTICE 'Guard boolean value: %', guard_value;
				ELSE
					-- Unknown cond structure: default to TRUE to avoid dropping transitions unexpectedly
					guard_value := TRUE;
					RAISE NOTICE 'Unknown guard condition structure, defaulting to TRUE';
				END IF;
			END IF;
		END IF;

		-- If guard evaluates to true, yield the transition record
		IF guard_value THEN
			RAISE NOTICE 'Guard condition passed, returning transition: %', transition_record;
			RETURN NEXT transition_record;
		END IF;
	END LOOP;

	RETURN;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.test_event_transition_for_entry_v2(event_name text, fsm_name_param text, fsm_version_param text)
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
    -- and call fsm_core.compute_entry_actions_v2 with is_initial_transition = TRUE
    -- else call with FALSE
    IF event_name = 'initialTransition_event' THEN
        SELECT fsm_core.compute_entry_actions_v2(transition_record, fsm_name_param, fsm_version_param, TRUE) INTO result;
    ELSE
        SELECT fsm_core.compute_entry_actions_v2(transition_record, fsm_name_param, fsm_version_param, FALSE) INTO result;
    END IF;


    RETURN result;
END;
$function$
;


revoke delete on table "public"."all_transition_records" from "anon";

revoke insert on table "public"."all_transition_records" from "anon";

revoke references on table "public"."all_transition_records" from "anon";

revoke select on table "public"."all_transition_records" from "anon";

revoke trigger on table "public"."all_transition_records" from "anon";

revoke truncate on table "public"."all_transition_records" from "anon";

revoke update on table "public"."all_transition_records" from "anon";

revoke delete on table "public"."all_transition_records" from "authenticated";

revoke insert on table "public"."all_transition_records" from "authenticated";

revoke references on table "public"."all_transition_records" from "authenticated";

revoke select on table "public"."all_transition_records" from "authenticated";

revoke trigger on table "public"."all_transition_records" from "authenticated";

revoke truncate on table "public"."all_transition_records" from "authenticated";

revoke update on table "public"."all_transition_records" from "authenticated";

revoke delete on table "public"."all_transition_records" from "service_role";

revoke insert on table "public"."all_transition_records" from "service_role";

revoke references on table "public"."all_transition_records" from "service_role";

revoke select on table "public"."all_transition_records" from "service_role";

revoke trigger on table "public"."all_transition_records" from "service_role";

revoke truncate on table "public"."all_transition_records" from "service_role";

revoke update on table "public"."all_transition_records" from "service_role";

drop table "public"."all_transition_records";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.test_event_transition_for_exit_v2(event_name text, p_state_node_set text[], fsm_name_param text, fsm_version_param text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    transition_record fsm_core.fsm_transitions;
    transition_json JSONB;
    result JSONB;
BEGIN
    -- Find single record from fsm_core.fsm_transitions based on event_type, fsm_name, and fsm_version
    SELECT * INTO transition_record
    FROM fsm_core.fsm_transitions 
    WHERE event_type = event_name 
      AND fsm_name = fsm_name_param 
      AND fsm_version = fsm_version_param
    LIMIT 1;


    SELECT fsm_core.compute_exit_actions_v2(transition_record, p_state_node_set, fsm_name_param, fsm_version_param) INTO result;


    RETURN result;
END;
$function$
;


