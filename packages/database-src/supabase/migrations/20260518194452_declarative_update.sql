drop function if exists "fsm_core"."send_event_to_fsm_queue_from_fsm_instance_id_v2"(event_name text, event_input jsonb, id text, action_type text, src text, fsmname text, fsmtype text, fsmversion text, parentfsmname text, parentfsmversion text, from_source_fsm_instance_id uuid);

drop function if exists "fsm_core"."send_event_to_promise_queue_from_fsm_instance_id_v2"(event_name text, event_input jsonb, id text, action_type text, src text, fsmname text, fsmtype text, fsmversion text, parentfsmname text, parentfsmversion text, from_source_fsm_instance_id uuid);

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.create_fsm_queue_and_send_event_from_fsm_instance_id_v2(event_name text, event_input jsonb, id text, action_type text, src text, fsmname text, fsmtype text, fsmversion text, parentfsmname text, parentfsmversion text, from_source_fsm_instance_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    child_instance_id uuid := uuid_generate_v4();
    send_result jsonb;
BEGIN
    PERFORM pgmq.create(queue_name := child_instance_id::text);

    send_result := fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
        input_fsm_instance_id := child_instance_id,
        input_fsm_instance_id_fsm_type := fsmType,
        input_fsm_instance_id_fsm_version := fsmVersion,
        input_send_to_parent_queue_id := from_source_fsm_instance_id,
        input_send_to_parent_queue_type := fsmType,
        input_send_to_parent_queue_id_event_name := id,
        input_event_name := event_name,
        input_event_action_type := action_type,
        input_event_data := event_input,
        input_event_delay := 0,
        input_event_status := 'fsm_started',
        input_event_output := '{}'::jsonb,
        input_error_message := NULL
    );

    RETURN send_result || jsonb_build_object('start_queue_worker', true, 'child_instance_id', child_instance_id);
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.create_promise_queue_and_send_event_from_fsm_instance_id_v2(event_name text, event_input jsonb, id text, action_type text, src text, fsmname text, fsmtype text, fsmversion text, parentfsmname text, parentfsmversion text, from_source_fsm_instance_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    promise_queue_name text;
    queue_exists boolean := false;
    start_queue_worker boolean := false;
    send_result jsonb;
BEGIN
    IF fsmType = 'promise' THEN
        promise_queue_name := parentFsmName || '_' || parentFsmVersion || '_' || fsmName;
    ELSIF fsmType = 'sharedPromise' THEN
        promise_queue_name := 'sharedPromise_' || fsmName || '_' || fsmVersion;
    ELSE
        RAISE EXCEPTION 'create_promise_queue_and_send_event_from_fsm_instance_id_v2: unsupported fsmType: %', fsmType;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM pgmq.list_queues() WHERE queue_name = promise_queue_name
    ) INTO queue_exists;

    IF NOT queue_exists THEN
        PERFORM pgmq.create(queue_name := promise_queue_name);
        start_queue_worker := true;
    END IF;

    send_result := fsm_core.send_event_to_promise_queue_with_event_logs_v2(
        input_promise_queue_name := promise_queue_name,
        input_promise_fn_name := fsmName,
        input_promise_queue_type := fsmType,
        input_promise_queue_version := fsmVersion,
        input_send_to_parent_queue_id := from_source_fsm_instance_id,
        input_send_to_parent_queue_type := 'FSM',
        input_send_to_parent_queue_id_event_name := id,
        input_event_name := event_name,
        input_event_action_type := action_type,
        input_event_data := event_input,
        input_event_delay := 0,
        input_event_status := 'pomise_started',
        input_event_output := '{}'::jsonb,
        input_error_message := NULL
    );

    RETURN send_result || jsonb_build_object('start_queue_worker', start_queue_worker);
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
	result_json JSONB;
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

	-- 5. Return result as JSONB
	result_json := jsonb_build_object(
		'updated_state_value_node_set', updated_state_nodes,
		'updated_state_value', updated_state_nodes_jsonb,
		'exit_actions', exit_result->'exit_actions',
		'entry_actions', entry_result->'entry_actions_for_states_to_enter',
		'initial_actions', entry_result->'initial_actions_for_common_states',
		'transition_actions', transition_actions
	);
	RAISE NOTICE 'fsm_core.microstep_v2 result: %', result_json;
	RETURN result_json;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.send_event_to_queue_from_fsm_instance_id_v2(event_name text, event_input jsonb, id text, action_type text, src text, fsmname text, fsmtype text, fsmversion text, parentfsmname text, parentfsmversion text, from_source_fsm_instance_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF fsmType = 'promise' OR fsmType = 'sharedPromise' THEN
        RETURN fsm_core.create_promise_queue_and_send_event_from_fsm_instance_id_v2(
            event_name := event_name,
            event_input := event_input,
            id := id,
            action_type := action_type,
            src := src,
            fsmName := fsmName,
            fsmType := fsmType,
            fsmVersion := fsmVersion,
            parentFsmName := parentFsmName,
            parentFsmVersion := parentFsmVersion,
            from_source_fsm_instance_id := from_source_fsm_instance_id
        );
    ELSIF fsmType = 'childFsm' THEN
        RETURN fsm_core.create_fsm_queue_and_send_event_from_fsm_instance_id_v2(
            event_name := event_name,
            event_input := event_input,
            id := id,
            action_type := action_type,
            src := src,
            fsmName := fsmName,
            fsmType := fsmType,
            fsmVersion := fsmVersion,
            parentFsmName := parentFsmName,
            parentFsmVersion := parentFsmVersion,
            from_source_fsm_instance_id := from_source_fsm_instance_id
        );
    ELSE
        RAISE EXCEPTION 'Unsupported fsmType: %', fsmType;
    END IF;
END;
$function$
;


