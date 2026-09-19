drop function if exists "fsm_core"."load_fsm_from_json_v2"(json_input jsonb, root_node_text text, input_fsm_type text, input_fsm_name text, input_fsm_version text, input_dependent_children jsonb);

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.load_fsm_from_json_v2(json_input jsonb, root_node_text text, input_fsm_name text, input_fsm_version text, input_dependent_children jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    state_result JSONB;
    transition_result JSONB;
    state_ok BOOLEAN;
    transition_ok BOOLEAN;
    schema_json JSON;
    schema_errors TEXT[];
    existing_fsm_json JSONB;
BEGIN
    SELECT fsm_json
    INTO existing_fsm_json
    FROM fsm_core.fsm_json
    WHERE fsm_name = input_fsm_name
      AND fsm_version = input_fsm_version
    LIMIT 1;

    IF existing_fsm_json IS NOT NULL THEN
        IF existing_fsm_json = json_input THEN
            RETURN jsonb_build_object(
                'ok', to_jsonb(true),
                'fsm_json', existing_fsm_json,
                'cached', to_jsonb(true)
            );
        ELSE
            RAISE EXCEPTION 'FSM % version % already loaded with different JSON content', input_fsm_name, input_fsm_version;
        END IF;
    END IF;

    -- SELECT config_value
    -- INTO schema_json
    -- FROM fsm_core.config_store
    -- WHERE config_name = 'fsm_schema'
    -- ORDER BY config_version DESC
    -- LIMIT 1;

    schema_json := fsm_core.fsm_json_schema();

    IF schema_json IS NULL THEN
        RAISE EXCEPTION 'Missing fsm_schema in fsm_core.config_store for % version %', input_fsm_name, input_fsm_version;
    END IF;

    schema_errors := fsm_core.jsonschema_validation_errors(schema_json, json_input::JSON);
    IF schema_errors IS NOT NULL AND array_length(schema_errors, 1) > 0 THEN
        RAISE NOTICE 'FSM schema validation errors for % version %: %', input_fsm_name, input_fsm_version, schema_errors;
        -- RAISE EXCEPTION 'json_input failed schema validation for % version %: %', input_fsm_name, input_fsm_version, schema_errors;
    END IF;

    state_result := fsm_core.load_fsm_state_from_json_v2(json_input := json_input, root_node_text := root_node_text, input_fsm_name := input_fsm_name, input_fsm_version := input_fsm_version);

    IF state_result IS NULL THEN
        RAISE EXCEPTION 'fsm_core.load_fsm_state_from_json_v2 returned NULL for % version %', input_fsm_name, input_fsm_version;
    END IF;

    state_ok := COALESCE((state_result->>'ok')::BOOLEAN, false);
    IF NOT state_ok THEN
        RAISE EXCEPTION 'fsm_core.load_fsm_state_from_json_v2 reported failure: %', state_result;
    END IF;

    transition_result := fsm_core.load_fsm_transition_from_json_v2(json_input := json_input, root_node_text := root_node_text, fsm_name := input_fsm_name, fsm_version := input_fsm_version);

    IF transition_result IS NULL THEN
        RAISE EXCEPTION 'fsm_core.load_fsm_transition_from_json_v2 returned NULL for % version %', input_fsm_name, input_fsm_version;
    END IF;

    transition_ok := COALESCE((transition_result->>'ok')::BOOLEAN, false);
    IF NOT transition_ok THEN
        RAISE EXCEPTION 'fsm_core.load_fsm_transition_from_json_v2 reported failure: %', transition_result;
    END IF;

    IF input_dependent_children IS NOT NULL
       AND jsonb_array_length(input_dependent_children) > 0 THEN
        PERFORM fsm_core.insert_fsm_dependencies(
            input_fsm_name, input_fsm_version, input_dependent_children
        );
    END IF;

    INSERT INTO fsm_core.fsm_json (fsm_name, fsm_version, fsm_json)
    VALUES (input_fsm_name, input_fsm_version, json_input);

    RETURN jsonb_build_object(
        'ok', to_jsonb(true),
        'cached', to_jsonb(false),
        'fsm_json', json_input,
        'state_result', state_result,
        'transition_result', transition_result
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.create_fsm_instance_from_name_v2(input_fsm_name text, input_fsm_version text, input_fsm_context jsonb, create_pgmq_queue boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    output_queue_created boolean := false;
    output_message text := NULL;
    output_extra_message text := NULL;
    fsm_instance_id uuid;
    send_event_result jsonb := NULL;
    derived_fsm_type text;
    fsm_json_exists boolean;
    fsm_instance_row      fsm_core.fsm_instance;
BEGIN
    -- 1. Check if fsm_name and fsm_version exist in fsm_core.fsm_json
    SELECT EXISTS (
        SELECT 1
        FROM fsm_core.fsm_json fj
        WHERE fj.fsm_name = input_fsm_name AND fj.fsm_version = input_fsm_version
    ) INTO fsm_json_exists;

    IF NOT fsm_json_exists THEN
        RAISE EXCEPTION 'FSM with name % and version % not found in fsm_core.fsm_json', input_fsm_name, input_fsm_version;
    END IF;

    -- 1.1. Derive fsm_type from fsm_core.fsm_dependencies: a row where this FSM
    -- is a child means it's a childfsm, otherwise it's a top-level fsm.
    IF EXISTS (
        SELECT 1
        FROM fsm_core.fsm_dependencies fd
        WHERE fd.child_fsm_name = input_fsm_name AND fd.child_fsm_version = input_fsm_version
    ) THEN
        derived_fsm_type := 'childfsm';
    ELSE
        derived_fsm_type := 'fsm';
    END IF;

    -- 2. Create new fsm_instance
    INSERT INTO fsm_core.fsm_instance (fsm_name, fsm_version, fsm_type, fsm_instance_context)
    VALUES (input_fsm_name, input_fsm_version, derived_fsm_type, input_fsm_context)
    RETURNING * INTO fsm_instance_row;

    fsm_instance_id := fsm_instance_row.id;

    -- 3. Insert all transitions into fsm_core.fsm_instance_transitions_auth
    INSERT INTO fsm_core.fsm_instance_transitions_auth (
        fsm_name, fsm_version, fsm_type, fsm_instance_id, fsm_instance_event_type, users, groups, module_tag, meta_info
    )
    SELECT
        t.fsm_name,
        t.fsm_version,
        derived_fsm_type,
        fsm_instance_id,
        t.event_type,
        ARRAY[]::jsonb[], -- users (default empty array)
        ARRAY[]::jsonb[], -- groups (default empty array)
        NULL::jsonb,      -- module_tag (default null)
        NULL::jsonb       -- meta_info (default null)
    FROM fsm_core.fsm_transitions t
    WHERE t.fsm_name = input_fsm_name AND t.fsm_version = input_fsm_version;

    -- 4. Enqueue to fsm_instance_and_fsm_workerlet and notify the fsmscheduler.
    PERFORM fsm_core.enqueue_fsm_dispatch_v2(
        fsm_instance_id,
        input_fsm_name,
        input_fsm_version,
        'start'
    );

    -- 5. Optionally create pgmq queue and send initial event
    IF create_pgmq_queue THEN
        BEGIN
            PERFORM pgmq.create(queue_name := fsm_instance_id::text);
            output_queue_created := true;
            output_message := 'Queue created successfully.';
            -- Try to send initialTransition_event to the queue
            BEGIN
                send_event_result := fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
                    input_fsm_instance_id := fsm_instance_id,
                    input_fsm_instance_id_fsm_type := derived_fsm_type,
                    input_fsm_instance_id_fsm_version := input_fsm_version,
                    input_send_to_parent_queue_id := fsm_core.pg_system_queue_uuid(),
                    input_send_to_parent_queue_type := fsm_core.pg_system_queue_type(),
                    input_send_to_parent_queue_id_event_name := fsm_core.pg_system_event_name(),
                    input_event_name := 'initialTransition_event',
                    input_event_action_type := 'system',
                    input_event_data := jsonb_build_object('source', 'system'),
                    input_event_delay := 0,
                    input_event_status := 'fsm_started',
                    input_event_output := '{}'::jsonb,
                    input_error_message := NULL,
                    input_execution_started_at := now(),
                    input_execution_duration := NULL,
                    input_execution_finished_at := now()
                );
                output_extra_message := 'initialTransition_event is also sent to queue.';
            EXCEPTION WHEN OTHERS THEN
                output_extra_message := SQLERRM;
            END;
        EXCEPTION WHEN OTHERS THEN
            output_queue_created := false;
            output_message := SQLERRM;
        END;
    ELSE
        output_queue_created := false;
        output_message := 'queue_created is false and no queue is created.';
        output_extra_message := NULL;
    END IF;

    RETURN jsonb_build_object(
        'queue_created', output_queue_created,
        'fsm_name', input_fsm_name,
        'fsm_version', input_fsm_version,
        'fsm_instance_id', fsm_instance_id,
        'fsm_instance_context', input_fsm_context,
        'send_event_result', send_event_result,
        'message', output_message,
        'extra_message', output_extra_message
    );
END;
$function$
;


