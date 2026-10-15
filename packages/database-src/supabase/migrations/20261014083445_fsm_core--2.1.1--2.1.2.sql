set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.microstep_v2(transition_record fsm_core.fsm_transitions, event_name text, state_value_node_set text[], fsm_name_param text, fsm_version_param text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
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
	result_json JSONB;
	is_done BOOLEAN;
BEGIN
	RAISE NOTICE 'fsm_core.microstep_v2 called with event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;
	
	RAISE NOTICE 'state_value_node_set: %', state_value_node_set;


	-- 1. Call processEventTransitionForExit
	exit_result := fsm_core.compute_exit_actions_v2(transition_record := transition_record, input_state_node_set := state_value_node_set, input_fsm_name := transition_record.fsm_name, input_fsm_version := transition_record.fsm_version);
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
		entry_result := fsm_core.compute_entry_actions_v2(transition_record := transition_record, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param, is_initial_transition := TRUE);
	ELSE
		entry_result := fsm_core.compute_entry_actions_v2(transition_record := transition_record, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param, is_initial_transition := FALSE);
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

	
	updated_state_nodes_jsonb := fsm_core.build_nested_json_recursive(paths := updated_state_nodes);
	RAISE NOTICE 'updated_state_nodes_jsonb: %', updated_state_nodes_jsonb;

	-- 5. done: the machine is now in a top-level final state (a final child
	--    of the root), so the instance has finished and the sync worker
	--    marks it done (#500). The root is matched by parent_node rather
	--    than by ltree depth: a root id with dots spans several labels.
	is_done := EXISTS (
		SELECT 1
		FROM fsm_core.fsm_states fs
		JOIN fsm_core.fsm_states root
		  ON root.fsm_name = fs.fsm_name
		 AND root.fsm_version = fs.fsm_version
		 AND root.parent_node IS NULL
		 AND fs.parent_node = root.computed_state_key_ltree::text
		WHERE fs.fsm_name = fsm_name_param
		  AND fs.fsm_version = fsm_version_param
		  AND fs.type = 'final'
		  AND fs.computed_state_key_ltree::text = ANY(updated_state_nodes)
	);

	-- 6. Return result as JSONB
	result_json := jsonb_build_object(
		'updated_state_value_node_set', updated_state_nodes,
		'updated_state_value', updated_state_nodes_jsonb,
		'exit_actions', exit_result->'exit_actions',
		'entry_actions', entry_result->'entry_actions_for_states_to_enter',
		'initial_actions', entry_result->'initial_actions_for_common_states',
		'transition_actions', transition_actions,
		'done', is_done
	);
	RAISE NOTICE 'fsm_core.microstep_v2 result: %', result_json;
	RETURN result_json;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.fsm_get_all_state_nodes_v2(input_state_paths text[], input_fsm_name text, input_fsm_version text)
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
    active_node text;
    ancestor text;
BEGIN
    RAISE NOTICE '[fsm_core.fsm_get_all_state_nodes_v2] Input state_paths: %', input_state_paths;
    
    SELECT array_agg(fsm_states ORDER BY fsm_order ASC) INTO all_fsm_states
    FROM fsm_core.fsm_states
    WHERE fsm_name = input_fsm_name AND fsm_version = input_fsm_version AND computed_state_key_ltree::text = ANY(input_state_paths);

    RAISE NOTICE '[fsm_core.fsm_get_all_state_nodes_v2] Matching fsm_core.fsm_states count: %', array_length(all_fsm_states, 1);

    FOR node_rec IN
        SELECT * FROM unnest(all_fsm_states) AS fsm_states
    LOOP
        log_text := log_text || format(E'\nProcessing node: %s (type=%s)', node_rec.computed_state_key_ltree, node_rec.type);
        RAISE NOTICE 'Processing node: % (type=%)', node_rec.computed_state_key_ltree, node_rec.type;
        IF node_rec.type = 'compound' THEN

            
            -- Check if node_rec.computed_state_key_ltree is immediate parent of any node in input_state_paths
            -- iterate through input_state_paths and check if any path has node_rec.computed_state_key_ltree as prefix (immediate parent)
            
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
                initialStates := fsm_core.fsm_get_initial_state_nodes_with_ancestors_v2(input_fsm_name := input_fsm_name, input_fsm_version := input_fsm_version, input_state_path := node_rec.computed_state_key_ltree::ltree);
               
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
            -- Regions are this FSM version's child rows, by key path like every
            -- other path here: a child's `id` (in `states`) is only its key path
            -- when it has no custom id. History children are not regions.
            FOR child_rec IN
                SELECT fs.computed_state_key_ltree::text AS path
                FROM fsm_core.fsm_states fs
                WHERE fs.fsm_name = input_fsm_name
                  AND fs.fsm_version = input_fsm_version
                  AND fs.parent_node = node_rec.computed_state_key_ltree::text
                  AND fs.type <> 'history'
                ORDER BY fs.fsm_order
            LOOP
                -- A region in the saved state keeps its own states (it is a node of
                -- its own here); only a region missing from it starts at its
                -- initial state. Adding every region's initial chain reset parallel
                -- states on every step (#503).
                CONTINUE WHEN child_rec.path = ANY(input_state_paths);
                RAISE NOTICE 'Processing child node in parallel state: %', child_rec.path;

                initialStates := fsm_core.fsm_get_initial_state_nodes_with_ancestors_v2(input_fsm_name := input_fsm_name, input_fsm_version := input_fsm_version, input_state_path := child_rec.path::ltree);
                RAISE NOTICE 'Initial states with ancestors for child node %: %', child_rec.path, initialStates;

                IF initialStates IS NOT NULL THEN
                    FOREACH initialStateNode IN ARRAY initialStates LOOP
                        IF initialStateNode IS NOT NULL AND NOT (initialStateNode = ANY(resultNodeset)) THEN
                            resultNodeset := array_append(resultNodeset, initialStateNode);
                            RAISE NOTICE 'Added child initialStateNode: %', initialStateNode;
                        END IF;
                    END LOOP;
                END IF;
            END LOOP;
        -- A final state is an active leaf too; skipping it dropped every
        -- region that had finished (#503).
        ELSEIF node_rec.type IN ('atomic', 'final') THEN
            
            RAISE NOTICE 'Atomic node % found, adding to resultNodeset...', node_rec.computed_state_key_ltree;
            resultNodeset := array_append(resultNodeset, node_rec.computed_state_key_ltree::text);
            
            RAISE NOTICE 'Added atomic node: %', node_rec.computed_state_key_ltree::text;
        ELSE
            log_text := log_text || E'\n  Node type is final/history or unknown, skipping it.';
            
        
        END IF;
    END LOOP;

   
    RAISE NOTICE '[fsm_core.fsm_get_all_state_nodes_v2] Log:%', log_text;
    RAISE NOTICE '[fsm_core.fsm_get_all_state_nodes_v2] ResultNodeset: %', resultNodeset;
    -- An active node's ancestors are active too (XState's configuration), so
    -- a transition defined on a compound or parallel state (its onDone, or an
    -- event it handles) matches. Without them only leaves could (#503).
    FOREACH active_node IN ARRAY COALESCE(resultNodeset, ARRAY[]::text[]) LOOP
        FOR i IN 1 .. nlevel(active_node::ltree) - 1 LOOP
            ancestor := subpath(active_node::ltree, 0, i)::text;
            IF NOT (ancestor = ANY(resultNodeset)) THEN
                resultNodeset := array_append(resultNodeset, ancestor);
            END IF;
        END LOOP;
    END LOOP;

    RETURN COALESCE(resultNodeset, ARRAY[]::text[]);
END;
$function$
;
