CREATE OR REPLACE FUNCTION fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
    input_fsm_instance_id uuid,
    input_fsm_instance_id_fsm_type text,
    input_fsm_instance_id_fsm_version text,
    input_send_to_parent_queue_id uuid,
    input_send_to_parent_queue_type text,
    input_send_to_parent_queue_id_event_name text,
    input_event_name text,
    input_event_action_type text,
    input_event_data jsonb,
    input_event_delay integer DEFAULT 0,
    input_event_status text DEFAULT 'ACTIVE',
    input_event_output jsonb DEFAULT '{}'::jsonb,
    input_error_message text DEFAULT NULL,
    input_execution_started_at timestamp with time zone DEFAULT now(),
    input_execution_duration integer DEFAULT NULL,
    input_execution_finished_at timestamp with time zone DEFAULT now()
)
RETURNS JSONB
AS $$
DECLARE
    queue_msg_data jsonb;
    output_fsm_instance_queue_msg_id bigint;
    output_fsm_instance_queue_event_log_id uuid;
BEGIN
    IF input_fsm_instance_id IS NULL THEN
        RAISE EXCEPTION 'fsm_instance_id is NULL';
    END IF;

    queue_msg_data := jsonb_build_object(
        
        'event_data', jsonb_build_object(
            'event_type', input_event_name,
            'event_payload', input_event_data,
            'action_type', input_event_action_type
        ),
        'queue_id', input_fsm_instance_id,
        'queue_type', input_fsm_instance_id_fsm_type,
        'queue_version', input_fsm_instance_id_fsm_version,
        'send_to_parent_queue_id', input_send_to_parent_queue_id,
        'send_to_parent_queue_type', input_send_to_parent_queue_type,
        'send_to_parent_queue_id_event_name', input_send_to_parent_queue_id_event_name
    );

    BEGIN
        SELECT pgmq.send(queue_name := input_fsm_instance_id::text, msg := queue_msg_data, delay := input_event_delay)
        INTO output_fsm_instance_queue_msg_id;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'pgmq.send failed for queue %: %', input_fsm_instance_id, SQLERRM;
    END;

    IF output_fsm_instance_queue_msg_id IS NULL THEN
        RAISE EXCEPTION 'Failed to send event to queue %', input_fsm_instance_id;
    END IF;

    -- Append queue_msg_id to queue_msg_data
    queue_msg_data := queue_msg_data || jsonb_build_object('queue_msg_id', output_fsm_instance_queue_msg_id);

    -- Append queue_msg_delay to queue_msg_data
    queue_msg_data := queue_msg_data || jsonb_build_object('queue_msg_delay', input_event_delay);

    INSERT INTO fsm_core.fsm_instance_queue_event_logs (
        fsm_instance_id,
        fsm_instance_id_fsm_type,
        fsm_instance_id_fsm_version,
        fsm_instance_queue_msg_id,
        event_name,
        event_data,
        event_delay,
        send_to_parent_queue_id,
        send_to_parent_queue_id_event_name,
        execution_started_at,
        execution_duration,
        execution_finished_at,
        event_status,
        event_output,
        error_message
    ) VALUES (
        input_fsm_instance_id,
        input_fsm_instance_id_fsm_type,
        input_fsm_instance_id_fsm_version,
        output_fsm_instance_queue_msg_id,
        input_event_name,
        input_event_data,
        input_event_delay,
        input_send_to_parent_queue_id,
        input_send_to_parent_queue_id_event_name,
        input_execution_started_at,
        input_execution_duration,
        input_execution_finished_at,
        input_event_status,
        input_event_output,
        input_error_message
    ) RETURNING fsm_instance_queue_event_log_id INTO output_fsm_instance_queue_event_log_id;

    RETURN jsonb_build_object(
     
        'queue_data', queue_msg_data,
        -- 'queue_msg_id', output_fsm_instance_queue_msg_id,
        -- 'queue_msg_delay', input_event_delay,
        'queue_event_log_id', output_fsm_instance_queue_event_log_id,
        'event_status', input_event_status,
        'event_output', input_event_output,
        'error_message', input_error_message
       
    );
END;
$$ LANGUAGE plpgsql;




-- Function: fsm_core.create_fsm_instance_from_name_v2
-- Purpose: Given a fsm_name, create a fsm_instance and related fsm_instance_transitions_auth entries from the latest fsm_transitions and its auths.


CREATE OR REPLACE FUNCTION fsm_core.create_fsm_instance_from_name_v2(
    input_fsm_name text,
    input_fsm_version TEXT,
    input_fsm_context jsonb,
    create_pgmq_queue boolean DEFAULT false
)
RETURNS JSONB
AS $$
DECLARE
    output_queue_created boolean := false;
    output_message text := NULL;
    output_extra_message text := NULL;
    fsm_instance_id uuid;
    send_event_result jsonb := NULL;
    derived_fsm_type text;
BEGIN
    -- 1. Check if fsm_name and fsm_version exist in fsm_core.fsm_json and get fsm_type
    SELECT fj.fsm_type INTO derived_fsm_type
    FROM fsm_core.fsm_json fj
    WHERE fj.fsm_name = input_fsm_name AND fj.fsm_version = input_fsm_version;

    IF derived_fsm_type IS NULL THEN
        RAISE EXCEPTION 'FSM with name % and version % not found in fsm_core.fsm_json', input_fsm_name, input_fsm_version;
    END IF;

    -- 2. Create new fsm_instance
    INSERT INTO fsm_core.fsm_instance (fsm_name, fsm_version, fsm_instance_context)
    VALUES (input_fsm_name, input_fsm_version, input_fsm_context)
    RETURNING id INTO fsm_instance_id;

    -- 3. Insert all transitions into fsm_core.fsm_instance_transitions_auth
    INSERT INTO fsm_core.fsm_instance_transitions_auth (
        fsm_name, fsm_version, fsm_instance_id, fsm_instance_event_type, users, groups, module_tag, meta_info
    )
    SELECT 
        t.fsm_name,
        t.fsm_version,
        fsm_instance_id,
        t.event_type,
        ARRAY[]::jsonb[], -- users (default empty array)
        ARRAY[]::jsonb[], -- groups (default empty array)
        NULL::jsonb,      -- module_tag (default null)
        NULL::jsonb       -- meta_info (default null)
    FROM fsm_core.fsm_transitions t
    WHERE t.fsm_name = input_fsm_name AND t.fsm_version = input_fsm_version;

    -- 4. Optionally create pgmq queue and send initial event
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
                    input_send_to_parent_queue_id := NULL,
                    input_send_to_parent_queue_type := NULL,
                    input_send_to_parent_queue_id_event_name := NULL,
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
$$ LANGUAGE plpgsql;



