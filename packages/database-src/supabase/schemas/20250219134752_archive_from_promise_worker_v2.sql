
CREATE OR REPLACE FUNCTION fsm_core.archive_event_from_fsm_promise_type_worker_v2(
    input_promise_queue_name text,
    input_promise_queue_type text,
    input_promise_queue_version text,
    input_promise_queue_msg_id bigint,
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
    promise_archive_result boolean;
    send_to_parent_result jsonb;
    output_promise_queue_event_log_id uuid;
BEGIN
    -- 1. Remove event from promise queue
    promise_archive_result := pgmq.archive(
        queue_name := input_promise_queue_name,
        msg_id := input_promise_queue_msg_id
    );

    -- 2. Send promise result back to parent FSM queue
    send_to_parent_result := fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
        input_fsm_instance_id := input_send_to_parent_queue_id,
        input_fsm_instance_id_fsm_type := NULL,
        input_fsm_instance_id_fsm_version := NULL,
        input_send_to_parent_queue_id := fsm_core.pg_system_queue_uuid(),
        input_send_to_parent_queue_type := fsm_core.pg_system_queue_type(),
        input_send_to_parent_queue_id_event_name := fsm_core.pg_system_event_name(),
        input_event_name := input_event_name,
        input_event_action_type := 'promise_completed',
        input_event_data := input_event_output,
        input_event_delay := 0,
        input_event_status := input_event_status,
        input_event_output := input_event_output,
        input_error_message := input_error_message,
        input_execution_started_at := input_execution_started_at,
        input_execution_duration := input_execution_duration,
        input_execution_finished_at := input_execution_finished_at
    );

    -- 3. Log archive event in promise queue event logs
    INSERT INTO fsm_core.fsm_promise_queue_event_logs (
        promise_queue_name,
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
        input_promise_queue_type,
        input_promise_queue_version,
        input_promise_queue_msg_id,
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
        'promise_queue_archive_result', promise_archive_result,
        'promise_queue_name', input_promise_queue_name,
        'promise_queue_msg_id', input_promise_queue_msg_id,
        'send_to_parent_result', send_to_parent_result,
        'promise_queue_event_log_id', output_promise_queue_event_log_id
    );
END;
$$ LANGUAGE plpgsql;



 -- remove event from queue promise_queue_name with queue_msg_id
 -- NOTE: push ( event_output json which has {type: send_event_name_to_parent_queue_id} from incoming msg ) on top of send_to_parent_queue_id queue ( which is not possible as PGMQ does not support priority queues below 1. and 2. will be perfomed as combine step)
 -- 1. update Sets the visibility timeout of a send_to_parent_queue_id_event_name to immediately available for processing 
 -- 2. update send_to_parent_queue_id in workflwow_instance  for remove_promise_queue_msg_ids : TBD (pending )
 -- optional: log data event_output, event_status, event_duration, event_finished_at in promise_queue_name_logs table



-- SELECT fsm_core.archive_event_from_fsm_promise_type_worker_v2(
--   'verifyCredentials'::TEXT,
--   1::BIGINT,
--   'd88bbbf6-1083-4ec8-8e53-a8add4f69e72'::UUID,
--   'xstate.done.actor.0.(machine).creditCheck.Verifying Credentials'::TEXT,
--   jsonb_build_object(
--     'type', 'xstate.done.actor.0.(machine).creditCheck.Verifying Credentials',
--     'output', null
--   )::JSONB,
--   'completed'::TEXT
-- );