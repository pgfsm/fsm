CREATE OR REPLACE FUNCTION fsm_core.send_event_to_queue_with_event_logs_v2(
    input_msg jsonb,
    input_event_source jsonb,
    input_event_name text DEFAULT NULL,
    input_event_delay integer DEFAULT 0,
    input_fsm_instance_id uuid DEFAULT NULL
)
-- RETURNS TABLE (
--     event_id uuid,
--     queue_msg_id bigint,
--     event_data jsonb
-- ) 
RETURNS JSONB
AS $$
DECLARE
    output_fsm_instance_queue_msg_id bigint;
    fsm_instance_queue_name text;
    fsm_instance_queue_event_logs_id uuid;
BEGIN
    IF input_fsm_instance_id IS NULL THEN
        RAISE EXCEPTION 'fsm_instance_id is NULL';
    END IF;

    fsm_instance_queue_name := input_fsm_instance_id::text;


    -- Call pgmq.send and get queue_msg_id
    BEGIN
        SELECT pgmq.send(fsm_instance_queue_name, input_msg, input_event_delay) INTO output_fsm_instance_queue_msg_id;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'pgmq.send failed for queue %: %', fsm_instance_queue_name, SQLERRM;
    END;
    IF output_fsm_instance_queue_msg_id IS NULL THEN
        RAISE EXCEPTION 'Failed to send event to queue %', fsm_instance_queue_name;
    END IF;

    -- Insert into fsm_core.fsm_instance_queue_event_logs and get id
    INSERT INTO fsm_core.fsm_instance_queue_event_logs (
        fsm_instance_id,
        event_name,
        event_data,
        fsm_instance_queue_msg_id,
        event_source,
        event_started_at,
        event_status
    ) VALUES (
        input_fsm_instance_id,
        input_event_name,
        input_msg,
        output_fsm_instance_queue_msg_id,
        input_event_source,
        now(),
        'queued'
    ) RETURNING id INTO fsm_instance_queue_event_logs_id;

    RETURN jsonb_build_object(
        'event_data', input_msg,
        'fsm_instance_queue_name', fsm_instance_queue_name,
        'fsm_instance_queue_msg_id', output_fsm_instance_queue_msg_id,
        'fsm_instance_queue_event_logs_id', fsm_instance_queue_event_logs_id
    );

    -- RETURN QUERY SELECT fsm_instance_event_logs_id, v_queue_msg_id, input_msg;

END;
$$ LANGUAGE plpgsql;





-- Function: fsm_core.create_fsm_instance_from_name_v2
-- Purpose: Given a fsm_name, create a fsm_instance and related fsm_instance_transitions_auth entries from the latest fsm_transitions and its auths.


CREATE OR REPLACE FUNCTION fsm_core.create_fsm_instance_from_name_v2(
    input_fsm_name text,
    input_fsm_version TEXT,
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
BEGIN
    -- 1. Find all transitions for the given FSM name and version
    IF NOT EXISTS (
        SELECT 1 FROM fsm_core.fsm_transitions WHERE fsm_name = input_fsm_name AND fsm_version = input_fsm_version
    ) THEN
        RAISE EXCEPTION 'No transitions found for FSM name % and version %', input_fsm_name, input_fsm_version;
    END IF;

    -- 2. Create new fsm_instance
    INSERT INTO fsm_core.fsm_instance (fsm_name, fsm_version)
    VALUES (input_fsm_name, input_fsm_version)
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
            PERFORM pgmq.create(fsm_instance_id::text);
            output_queue_created := true;
            output_message := 'Queue created successfully.';
            -- Try to send initialTransition_event to the queue
            BEGIN
                send_event_result := fsm_core.send_event_to_queue_with_event_logs_v2(
                    jsonb_build_object('type', 'initialTransition_event'),
                    jsonb_build_object('source', 'system'),
                    'initialTransition_event',
                    0,
                    fsm_instance_id
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
        'fsm_instance_id', fsm_instance_id,
        'fsm_name', input_fsm_name,
        'fsm_version', input_fsm_version,
        'queue_created', output_queue_created,
        'message', output_message,
        'extra_message', output_extra_message,
        'send_event_result', send_event_result
    );
END;
$$ LANGUAGE plpgsql;



