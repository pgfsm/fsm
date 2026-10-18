CREATE OR REPLACE FUNCTION fsm_core.cancel_event_for_fsm_async_operation_type_worker_v2(
    async_operation_type_worker_name text,
    queue_msg_id bigint
)
RETURNS jsonb

AS $$
DECLARE
   archive_result BOOLEAN;
BEGIN
   --  1. Remove queue_msg_id from the async_operation_type_worker_name queue using PGMQ
   -- IF async_operation_type_worker_name IS NOT NULL AND async_operation_type_worker_name <> '' AND queue_msg_id IS NOT NULL THEN

       archive_result := pgmq.archive(queue_name := async_operation_type_worker_name, msg_id := queue_msg_id);
   -- ELSE
   --    archive_result := false;
   -- END IF;

    -- 2. Notify on one fixed channel, with the queue and message in the
    --    payload, for a listener that cancels an invoke already in flight.
    --    The channel used to be 'fsm_async_operation_worker_' || <queue name>,
    --    which passed PostgreSQL's 63-byte limit for any queue name of 37+
    --    characters and failed the whole archive (#512). Nothing listens yet:
    --    the Activity Gateway will, to send the worker a Cancel (#514).
    --    Delivered only when the archive's transaction commits.
    PERFORM pg_notify(
        'fsm_async_operation_cancel',
        jsonb_build_object(
            'queue_name', async_operation_type_worker_name,
            'msg_id', queue_msg_id
        )::text
    );

    -- 3. Log event to fsm_async_operation_queue_event_logs (allow null queue id but record name)
    INSERT INTO fsm_core.fsm_async_operation_queue_event_logs (
        event_name,
        event_data,
        async_operation_queue_name,
        async_operation_queue_msg_id,
        -- send_to_parent_queue_id,
        -- send_to_parent_queue_id_msg_id,
        event_status,
        execution_finished_at
    ) VALUES (
        'cancel',
        NULL,
        async_operation_type_worker_name,
        queue_msg_id,
        'canceled',
        now()
    );

    RETURN jsonb_build_object(
        'archive_result', archive_result,
        'async_operation_queue_name', async_operation_type_worker_name,
        'queue_msg_id', queue_msg_id,
        'status', 'canceled'
    );
END;
$$ LANGUAGE plpgsql;

-- SELECT fsm_core.cancel_event_for_fsm_async_operation_type_worker_v2('creditCheck_v01_verifyCredentials', 1::BIGINT);
