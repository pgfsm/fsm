-- Fixes archive_event_from_fsm_async_operation_type_worker_v2's step 2 (send
-- async-operation result back to parent FSM queue): only actually sends when
-- input_send_to_parent_queue_id is a real parent FSM instance id -- not
-- NULL, and not one of the two "no real parent" sentinel uuids
-- (fsm_core.pg_system_queue_uuid() / fsm_core.api_system_queue_uuid()).
--
-- Before this fix, step 2 called send_event_to_fsm_queue_with_event_logs_v2
-- unconditionally with input_fsm_instance_id := input_send_to_parent_queue_id.
-- That function raises an exception on a NULL fsm_instance_id (see its own
-- "IF input_fsm_instance_id IS NULL THEN RAISE EXCEPTION" guard), and a
-- sentinel uuid isn't a real fsm_instance row either -- so an async-operation
-- actor invocation with no real waiting parent (e.g. triggered directly via
-- the API, using api_system_queue_uuid(), or some other system-internal path
-- using pg_system_queue_uuid()) would fail archival entirely instead of
-- just skipping the parent-notification step, which is the only part that
-- actually needs a real parent.
CREATE OR REPLACE FUNCTION fsm_core.archive_event_from_fsm_async_operation_type_worker_v2(
    input_async_operation_queue_name text,
    input_async_operation_queue_type text,
    input_async_operation_queue_version text,
    input_async_operation_queue_msg_id bigint,
    input_event_name text,
    input_event_action_type text,
    input_event_data jsonb,
    input_event_delay integer,
    input_send_to_parent_queue_id uuid,
    input_send_to_parent_queue_id_event_name text,
    input_execution_started_at timestamp with time zone,
    input_execution_duration integer,
    input_execution_finished_at timestamp with time zone,
    input_event_status text,
    input_event_output jsonb,
    input_error_message text
)
RETURNS jsonb
AS $$
DECLARE
    async_operation_archive_result boolean;
    send_to_parent_result jsonb;
    output_async_operation_queue_event_log_id uuid;
BEGIN
    -- 1. Remove event from async-operation queue
    async_operation_archive_result := pgmq.archive(
        queue_name := input_async_operation_queue_name,
        msg_id := input_async_operation_queue_msg_id
    );

    -- 2. Send async-operation result back to parent FSM queue -- only when
    -- there is a real parent to notify.
    IF input_send_to_parent_queue_id IS NOT NULL
        AND input_send_to_parent_queue_id <> fsm_core.pg_system_queue_uuid()
        AND input_send_to_parent_queue_id <> fsm_core.api_system_queue_uuid()
    THEN
        send_to_parent_result := fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
            input_fsm_instance_id := input_send_to_parent_queue_id,
            input_fsm_instance_id_fsm_type := NULL,
            input_fsm_instance_id_fsm_version := NULL,
            input_event_name := input_event_name,
            input_event_action_type := 'async_operation_completed',
            input_event_data := input_event_output,
            input_event_delay := 0,
            input_event_status := input_event_status,
            input_event_output := input_event_output,
            input_error_message := input_error_message,
            input_execution_started_at := input_execution_started_at,
            input_execution_duration := input_execution_duration,
            input_execution_finished_at := input_execution_finished_at
        );
    ELSE
        send_to_parent_result := jsonb_build_object('skipped', true, 'reason', 'no real parent to notify');
    END IF;

    -- 3. Log archive event in async-operation queue event logs
    INSERT INTO fsm_core.fsm_async_operation_queue_event_logs (
        async_operation_queue_name,
        async_operation_queue_type,
        async_operation_queue_version,
        async_operation_queue_msg_id,
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
        input_async_operation_queue_name,
        input_async_operation_queue_type,
        input_async_operation_queue_version,
        input_async_operation_queue_msg_id,
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
    ) RETURNING async_operation_queue_event_log_id INTO output_async_operation_queue_event_log_id;

    RETURN jsonb_build_object(
        'async_operation_queue_archive_result', async_operation_archive_result,
        'async_operation_queue_name', input_async_operation_queue_name,
        'async_operation_queue_msg_id', input_async_operation_queue_msg_id,
        'send_to_parent_result', send_to_parent_result,
        'async_operation_queue_event_log_id', output_async_operation_queue_event_log_id
    );
END;
$$ LANGUAGE plpgsql;
