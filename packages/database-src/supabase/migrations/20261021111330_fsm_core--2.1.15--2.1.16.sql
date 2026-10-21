set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.log_async_operation_cancel_ack_v2(input_async_operation_queue_name text, input_async_operation_queue_msg_id bigint, input_invoke_id text, input_reason text, input_outcome text, input_cancel_to_ack_ms integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
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
$function$
;


-- Not captured by `supabase db diff` (see packages/database-src/CLAUDE.md,
-- "Access control"): the Activity Gateway records cancel acknowledgements
-- through this as fsm_worker (#539).
REVOKE EXECUTE ON FUNCTION fsm_core.log_async_operation_cancel_ack_v2(text, bigint, text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fsm_core.log_async_operation_cancel_ack_v2(text, bigint, text, text, text, integer) TO fsm_worker;
