set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.create_fsm_instance_from_name_v2(input_fsm_name text, input_fsm_version text, input_fsm_context jsonb, create_pgmq_queue boolean DEFAULT false)
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
    dispatch_queue_exists boolean;
    fsm_instance_row      fsm_core.fsm_instance;
BEGIN
    -- 1. Check if fsm_name and fsm_version exist in fsm_core.fsm_json and get fsm_type
    SELECT fj.fsm_type INTO derived_fsm_type
    FROM fsm_core.fsm_json fj
    WHERE fj.fsm_name = input_fsm_name AND fj.fsm_version = input_fsm_version;

    IF derived_fsm_type IS NULL THEN
        RAISE EXCEPTION 'FSM with name % and version % not found in fsm_core.fsm_json', input_fsm_name, input_fsm_version;
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

    -- 4. Send to master_worker_dispatch_queue (create queue first if it does not exist)
    SELECT EXISTS (
        SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'master_worker_dispatch_queue'
    ) INTO dispatch_queue_exists;

    IF NOT dispatch_queue_exists THEN
        PERFORM pgmq.create(queue_name := 'master_worker_dispatch_queue');
    END IF;

    PERFORM pgmq.send(
        queue_name := 'master_worker_dispatch_queue',
        msg        := to_jsonb(fsm_instance_row)
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


