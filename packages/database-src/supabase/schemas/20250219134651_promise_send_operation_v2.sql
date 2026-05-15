CREATE OR REPLACE FUNCTION fsm_core.send_event_to_promise_queue_with_event_logs_v2(
    input_promise_queue_name text,
    input_promise_fn_name text,
    input_promise_queue_type text,
    input_promise_queue_version text,
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
    output_promise_queue_msg_id bigint;
    output_promise_queue_event_log_id uuid;
BEGIN
    IF input_promise_queue_name IS NULL THEN
        RAISE EXCEPTION 'promise_queue_name is NULL';
    END IF;

    queue_msg_data := jsonb_build_object(
        'event_data', jsonb_build_object(
            'event_type', input_event_name,
            'event_payload', input_event_data,
            'action_type', input_event_action_type
        ),
        'queue_id', input_promise_queue_name,
        'queue_fn_name', input_promise_fn_name,
        'queue_type', input_promise_queue_type,
        'queue_version', input_promise_queue_version,
        'send_to_parent_queue_id', input_send_to_parent_queue_id,
        'send_to_parent_queue_type', input_send_to_parent_queue_type,
        'send_to_parent_queue_id_event_name', input_send_to_parent_queue_id_event_name
    );

    BEGIN
        SELECT pgmq.send(input_promise_queue_name, queue_msg_data, input_event_delay)
        INTO output_promise_queue_msg_id;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'pgmq.send failed for queue %: %', input_promise_queue_name, SQLERRM;
    END;

    IF output_promise_queue_msg_id IS NULL THEN
        RAISE EXCEPTION 'Failed to send event to queue %', input_promise_queue_name;
    END IF;

    -- Append queue_msg_id to queue_msg_data
    queue_msg_data := queue_msg_data || jsonb_build_object('queue_msg_id', output_promise_queue_msg_id);

    -- Append queue_msg_delay to queue_msg_data
    queue_msg_data := queue_msg_data || jsonb_build_object('queue_msg_delay', input_event_delay);


    INSERT INTO fsm_core.fsm_promise_queue_event_logs (
        promise_queue_name,
        promise_fn_name,
        promise_queue_type,
        promise_queue_version,
        promise_queue_msg_id,
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
        input_promise_queue_name,
        input_promise_fn_name,
        input_promise_queue_type,
        input_promise_queue_version,
        output_promise_queue_msg_id,
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
    ) RETURNING promise_queue_event_log_id INTO output_promise_queue_event_log_id;

    
    RETURN jsonb_build_object(
        'queue_data', queue_msg_data,
        -- 'queue_msg_id', output_promise_queue_msg_id,
        -- 'queue_msg_delay', input_event_delay,
        'queue_event_log_id', output_promise_queue_event_log_id,
        'event_status', input_event_status,
        'event_output', input_event_output,
        'error_message', input_error_message
    );
END;
$$ LANGUAGE plpgsql;

