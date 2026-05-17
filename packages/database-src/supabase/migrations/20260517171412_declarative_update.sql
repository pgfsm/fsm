drop function if exists "fsm_core"."compute_exit_actions_v2"(transition_record fsm_core.fsm_transitions, p_state_node_set text[], p_fsm_name text, p_fsm_version text);

drop function if exists "fsm_core"."fsm_get_all_state_nodes_v2"(p_state_paths text[], p_fsm_name text, p_fsm_version text);

drop function if exists "fsm_core"."fsm_get_initial_state_nodes_v2"(p_fsm_name text, p_fsm_version text, p_state_path ltree);

drop function if exists "fsm_core"."fsm_get_initial_state_nodes_with_ancestors_v2"(p_fsm_name text, p_fsm_version text, p_state_path ltree);

drop function if exists "fsm_core"."fsm_worker_v2"(event_name text, p_state_value jsonb, fsm_name_param text, fsm_version_param text);

drop function if exists "fsm_core"."get_entry_actions_v2"(p_state_paths text[], p_fsm_name text, p_fsm_version text);

drop function if exists "fsm_core"."get_exit_actions_v2"(p_state_paths text[], p_fsm_name text, p_fsm_version text);

drop function if exists "fsm_core"."get_initial_actions_v2"(p_state_paths text[], p_fsm_name text, p_fsm_version text);

drop function if exists "fsm_core"."lock_fsm_instance"(p_fsm_instance_id uuid, p_locked_by text);

drop function if exists "fsm_core"."macrostep_v2"(event_name text, p_state_value text[], fsm_name_param text, fsm_version_param text);

drop function if exists "fsm_core"."select_all_transitions_v2"(event_name text, p_state_value text[], fsm_name_param text, fsm_version_param text);

drop function if exists "fsm_core"."unlock_fsm_instance"(p_fsm_instance_id uuid);

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.compute_exit_actions_v2(transition_record fsm_core.fsm_transitions, input_state_node_set text[], input_fsm_name text, input_fsm_version text)
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
  SELECT fsm_core.compute_full_exit_set_v2(transition_record := transition_record, state_node_set := input_state_node_set) INTO exit_set_result;

  RAISE NOTICE 'Exit Set Result: %', exit_set_result;

  -- Step 2: Call fsm_core.get_exit_actions_v2 with the result from step 1
  SELECT fsm_core.get_exit_actions_v2(input_state_paths := exit_set_result, input_fsm_name := input_fsm_name, input_fsm_version := input_fsm_version) INTO actions_result;

  RAISE NOTICE 'exit_actions Result: %', actions_result;

  -- Return both exit_nodes and exit_actions as a JSON object
  RETURN jsonb_build_object(
    'exit_nodes', exit_set_result,
    'exit_actions', actions_result->'actions'
  );
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
            IF node_rec.states IS NOT NULL THEN
                FOR child_rec IN SELECT value FROM jsonb_each(node_rec.states) LOOP
                    RAISE NOTICE 'Processing child node in parallel state: %', child_rec.value->>'id';
                    
                    initialStates := fsm_core.fsm_get_initial_state_nodes_with_ancestors_v2(input_fsm_name := input_fsm_name, input_fsm_version := input_fsm_version, input_state_path := fsm_core.sanitize_text_to_ltree(input_text := child_rec.value->>'id'));
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

CREATE OR REPLACE FUNCTION fsm_core.fsm_get_initial_state_nodes_v2(input_fsm_name text, input_fsm_version text, input_state_path ltree)
 RETURNS text[]
 LANGUAGE plpgsql
AS $function$
DECLARE
    results text[];
BEGIN
    WITH RECURSIVE traverse(node_path) AS (
        -- Base case
        SELECT input_state_path

        UNION ALL

        -- Recursive step: handle compound and parallel in one recursive query
        SELECT
            CASE
                WHEN s.type = 'compound'
                     AND s.initial->'target'->>0 IS NOT NULL
                THEN fsm_core.sanitize_text_to_ltree(input_text := s.initial->'target'->>0)::ltree

                WHEN s.type = 'parallel'
                     AND s.states IS NOT NULL
                THEN (t.node_path::text || '.' || fsm_core.sanitize_text_to_ltree(input_text := c.value->>'key')::text)::ltree

                ELSE NULL
            END AS next_path
        FROM traverse t
        JOIN fsm_core.fsm_states s
          ON s.computed_state_key_ltree = t.node_path
         AND s.fsm_name = input_fsm_name
         AND s.fsm_version = input_fsm_version
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

CREATE OR REPLACE FUNCTION fsm_core.fsm_get_initial_state_nodes_with_ancestors_v2(input_fsm_name text, input_fsm_version text, input_state_path ltree)
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
    initial_nodes := fsm_core.fsm_get_initial_state_nodes_v2(input_fsm_name := input_fsm_name, input_fsm_version := input_fsm_version, input_state_path := input_state_path);

    -- Add initial nodes to result
    IF initial_nodes IS NOT NULL THEN
        all_nodes := initial_nodes;
        -- For each initial node, add its proper ancestors up to input_state_path
        FOREACH node IN ARRAY initial_nodes LOOP
            ancestors := fsm_core.get_proper_ancestors(state_path_ltree := node, to_state_path_ltree := input_state_path::text);
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

CREATE OR REPLACE FUNCTION fsm_core.fsm_worker_v2(event_name text, input_state_value jsonb, fsm_name_param text, fsm_version_param text)
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
	-- assume input_state_value value would be drived from get_fsm_data function which fetches the current state value from database based on fsm_name and fsm_version, and then resolve_state_value function resolves it to get the set of active state nodes
	select fsm_core.resolve_state_value_v2(input_json := input_state_value::jsonb, input_fsm_name := fsm_name_param, input_fsm_version := fsm_version_param) INTO resolve_state_value_result;

	RAISE NOTICE 'resolve_state_value_result: %', resolve_state_value_result;
	state_node_set := array(
		SELECT jsonb_array_elements_text(resolve_state_value_result->'all_nodes')
	);
	
	RAISE NOTICE 'state_node_set: %', state_node_set;

	
	-- Call fsm_core.macrostep_v2 and return its JSONB result
	macrostep_result := fsm_core.macrostep_v2(
		event_name := event_name,
		input_state_value := state_node_set,
		fsm_name_param := fsm_name_param,
		fsm_version_param := fsm_version_param
	);

	RAISE NOTICE 'fsm_core.macrostep_v2: %', macrostep_result;

	-- call archive_event_from_fsm_type_worker with right Data

	RETURN macrostep_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.get_entry_actions_v2(input_state_paths text[], input_fsm_name text, input_fsm_version text)
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
            fs.fsm_order,
            fs.fsm_name,
            fs.fsm_version
        FROM fsm_core.fsm_states fs
        WHERE 
            fs.computed_state_key_ltree = ANY(input_state_paths::ltree[])
            AND fs.fsm_name = input_fsm_name
            AND fs.fsm_version = input_fsm_version
        ORDER BY fs.fsm_order DESC
    LOOP
        -- Process entry actions and add to combined array
        IF jsonb_array_length(rec.entry_actions) > 0 THEN
            FOR i IN 0..jsonb_array_length(rec.entry_actions)-1 LOOP
                action := rec.entry_actions->i;
                action := action || jsonb_build_object(
                    'fsm_order', rec.fsm_order,
                    'action_type', 'entry',
                    'parentFsmName', rec.fsm_name,
                    'parentFsmVersion', rec.fsm_version
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
                    'action_type', 'invoke',
                    'parentFsmName', rec.fsm_name,
                    'parentFsmVersion', rec.fsm_version
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

CREATE OR REPLACE FUNCTION fsm_core.get_exit_actions_v2(input_state_paths text[], input_fsm_name text, input_fsm_version text)
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
            -- input_state_paths should be always matched from computed_state_key_ltree column
            fs.computed_state_key_ltree = ANY(input_state_paths::ltree[])
            AND fs.fsm_name = input_fsm_name
            AND fs.fsm_version = input_fsm_version
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

CREATE OR REPLACE FUNCTION fsm_core.get_initial_actions_v2(input_state_paths text[], input_fsm_name text, input_fsm_version text)
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
            fs.computed_state_key_ltree = ANY(input_state_paths::ltree[])
            AND fs.fsm_name = input_fsm_name
            AND fs.fsm_version = input_fsm_version
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

CREATE OR REPLACE FUNCTION fsm_core.lock_fsm_instance(input_fsm_instance_id uuid, input_locked_by text)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
    updated_count INTEGER;
BEGIN
    -- Step 1: Check if the fsm_instance_id exists in referenced table
    IF NOT EXISTS (
        SELECT 1 FROM fsm_core.fsm_instance WHERE id = input_fsm_instance_id
    ) THEN
        RETURN FALSE;  -- Or raise an exception if required
    END IF;

    -- Step 2: Try to insert or update lock
    INSERT INTO fsm_core.fsm_instance_lock (
        fsm_instance_id, locked, locked_by, locked_at
    )
    VALUES (
        input_fsm_instance_id, TRUE, input_locked_by, now()
    )
    ON CONFLICT (fsm_instance_id)
    DO UPDATE
    SET locked = TRUE,
        locked_by = EXCLUDED.locked_by,
        locked_at = now(),
        expires_at = NULL
    WHERE fsm_instance_lock.locked = FALSE;

    -- Step 3: Check if insert/update actually happened
    GET DIAGNOSTICS updated_count = ROW_COUNT;

    RETURN updated_count > 0;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.macrostep_v2(event_name text, input_state_value text[], fsm_name_param text, fsm_version_param text)
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
			FROM jsonb_array_elements(fsm_core.select_all_transitions_v2(event_name := event_name, input_state_value := input_state_value, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param)) elem
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
				FROM fsm_core.select_transitions_with_guard_eval_v2(input_all_transitions := all_transition_records) t;

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
		transition_record := transition_record,
		event_name := event_name,
		state_value_node_set := input_state_value,
		fsm_name_param := fsm_name_param,
		fsm_version_param := fsm_version_param
	);

	RAISE NOTICE 'microstep_result: %', microstep_result;

	RETURN microstep_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.select_all_transitions_v2(event_name text, input_state_value text[], fsm_name_param text, fsm_version_param text)
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
			  AND computed_sanitized_source_ltree::text = ANY(input_state_value)
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

CREATE OR REPLACE FUNCTION fsm_core.unlock_fsm_instance(input_fsm_instance_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
    updated_count INTEGER;
BEGIN
    -- Try to update the lock to unlock it
    UPDATE fsm_core.fsm_instance_lock
    SET locked = FALSE,
        locked_by = NULL,
        locked_at = NULL,
        expires_at = NULL
    WHERE fsm_instance_id = input_fsm_instance_id
      AND locked = TRUE;

    -- Check if the row was updated
    GET DIAGNOSTICS updated_count = ROW_COUNT;

    -- If updated_count > 0, it means it was successfully unlocked
    RETURN updated_count > 0;
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
          select fsm_core.resolve_state_value_v2(input_json := '{}'::jsonb, input_fsm_name := fsm_name_param, input_fsm_version := fsm_version_param) INTO resolve_state_value_result;
        --   states_to_enter := resolve_state_value_result->'all_nodes';
          states_to_enter := array(
                SELECT jsonb_array_elements_text(resolve_state_value_result->'all_nodes')
            );

          SELECT fsm_core.get_entry_actions_v2(input_state_paths := states_to_enter, input_fsm_name := fsm_name_param, input_fsm_version := fsm_version_param) INTO entry_actions_result;
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
            child_result := fsm_core.get_descendant_states_for_entry_v2(input_state_id := sanitized_target_state::text, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param);
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
            ancestors := fsm_core.get_proper_ancestors(state_path_ltree := sanitized_effective_target_state::TEXT, to_state_path_ltree := transition_domain_lca::TEXT);

            -- If domain is parallel, append domain to ancestors
            IF domain_type = 'parallel' THEN
                ancestors := array_append(ancestors, transition_domain_lca::TEXT);
            END IF;

            
            ancestors_result := fsm_core.get_ancestor_states_for_entry_v2(
                ancestors := ancestors,
                reentrancy_domain := CASE WHEN transition_record.source IS NULL AND transition_record.reenter THEN NULL ELSE transition_domain_lca::TEXT END,
                fsm_name_param := fsm_name_param,
                fsm_version_param := fsm_version_param
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
    SELECT fsm_core.get_entry_actions_v2(input_state_paths := states_to_enter, input_fsm_name := fsm_name_param, input_fsm_version := fsm_version_param) INTO entry_actions_result;

    -- -- Get entry actions for states_for_default_entry
    -- SELECT fsm_core.get_entry_actions_v2(states_for_default_entry, fsm_name_param, fsm_version_param) INTO default_entry_actions_result;
    -- Get entry actions for the common states
    IF array_length(common_states, 1) > 0 THEN
        SELECT fsm_core.get_initial_actions_v2(input_state_paths := common_states, input_fsm_name := fsm_name_param, input_fsm_version := fsm_version_param) INTO initial_actions_for_common_states_result;
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
        all_paths := fsm_core.jsonb_all_paths(j := input_json, prefix := root_node);
    ELSE
        all_paths := fsm_core.jsonb_all_paths(j := input_json, prefix := '');
    END IF;

    RAISE NOTICE 'All paths: %', all_paths;
    -- Get all state nodes for these paths
    all_nodes := fsm_core.fsm_get_all_state_nodes_v2(input_state_paths := all_paths, input_fsm_name := input_fsm_name, input_fsm_version := input_fsm_version);

    RAISE NOTICE 'All nodes after fsm_core.fsm_get_all_state_nodes_v2: %', all_nodes;
    -- Build nested JSON from the state nodes
    nested_json := fsm_core.build_nested_json_recursive(paths := all_nodes);

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


drop function if exists "public"."test_event_transition_for_exit_v2"(event_name text, p_state_node_set text[], fsm_name_param text, fsm_version_param text);

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.test_event_transition_for_exit_v2(event_name text, input_state_node_set text[], fsm_name_param text, fsm_version_param text)
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


    SELECT fsm_core.compute_exit_actions_v2(transition_record := transition_record, input_state_node_set := input_state_node_set, input_fsm_name := fsm_name_param, input_fsm_version := fsm_version_param) INTO result;


    RETURN result;
END;
$function$
;


