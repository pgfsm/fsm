-- log_async_operation_cancel_ack_v2 (SPEC-012 (c), #539): records a worker's
-- reply to an invoke the Activity Gateway cancelled, in
-- fsm_async_operation_queue_event_logs, next to the message's other rows
-- (its start, the 'canceled' row of finish_async_operation_event_v2 when the
-- state exited, and so on).
--
-- One row per acknowledgement, written by the gateway when the worker replies
-- (the reply only frees its slot; it is never archived):
--   event_name   'cancel_ack'
--   event_status 'cancel_acknowledged'
--   event_data   {invoke_id, reason, outcome, cancel_to_ack_ms}
--     reason   STATE_EXITED | TIMEOUT (no row for SHUTDOWN: the stream ends
--              right after, so no reply can come back)
--     outcome  aborted (the handler stopped: InvokeError CANCELLED) |
--              completed (it returned anyway) | failed (it failed anyway)
-- Returns the row's id.
CREATE OR REPLACE FUNCTION fsm_core.log_async_operation_cancel_ack_v2(
    input_async_operation_queue_name text,
    input_async_operation_queue_msg_id bigint,
    input_invoke_id text,
    input_reason text,
    input_outcome text,
    input_cancel_to_ack_ms integer
) RETURNS uuid AS $$
DECLARE
    output_async_operation_queue_event_log_id uuid;
BEGIN
    IF input_outcome IS NULL OR input_outcome NOT IN ('aborted', 'completed', 'failed') THEN
        RAISE EXCEPTION 'log_async_operation_cancel_ack_v2: the outcome must be aborted, completed or failed, not %', input_outcome;
    END IF;

    INSERT INTO fsm_core.fsm_async_operation_queue_event_logs (
        async_operation_queue_name,
        async_operation_queue_msg_id,
        event_name,
        event_data,
        event_status,
        execution_finished_at
    ) VALUES (
        input_async_operation_queue_name,
        input_async_operation_queue_msg_id,
        'cancel_ack',
        jsonb_build_object(
            'invoke_id', input_invoke_id,
            'reason', input_reason,
            'outcome', input_outcome,
            'cancel_to_ack_ms', input_cancel_to_ack_ms
        ),
        'cancel_acknowledged',
        now()
    ) RETURNING async_operation_queue_event_log_id INTO output_async_operation_queue_event_log_id;

    RETURN output_async_operation_queue_event_log_id;
END;
$$ LANGUAGE plpgsql;
