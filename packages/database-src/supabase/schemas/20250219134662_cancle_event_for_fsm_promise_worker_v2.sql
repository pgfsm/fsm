CREATE OR REPLACE FUNCTION fsm_core.cancel_event_for_fsm_promise_type_worker_v2(
    promise_type_worker_name text,
    queue_msg_id bigint
) 
RETURNS jsonb 

AS $$
DECLARE
   archive_result BOOLEAN;
BEGIN
   --  1. Remove queue_msg_id from the promise_type_worker_name queue using PGMQ
   -- IF promise_type_worker_name IS NOT NULL AND promise_type_worker_name <> '' AND queue_msg_id IS NOT NULL THEN
    
       archive_result := pgmq.archive(queue_name := promise_type_worker_name, msg_id := queue_msg_id);
   -- ELSE
   --    archive_result := false;
   -- END IF;

    -- 2. Notify all workers via pg_notify (only when queue name present)
    -- IF promise_type_worker_name IS NOT NULL AND promise_type_worker_name <> '' THEN
        PERFORM pg_notify('fsm_promise_worker_' || promise_type_worker_name, COALESCE(queue_msg_id::text, ''));
    -- END IF;

    -- 3. Log event to fsm_promise_queue_event_logs (allow null queue id but record name)
    INSERT INTO fsm_core.fsm_promise_queue_event_logs (
        event_name,
        event_data,
        promise_queue_name,
        promise_queue_msg_id,
        -- send_to_parent_queue_id,
        -- send_to_parent_queue_id_msg_id,
        event_status,
        execution_finished_at
    ) VALUES (
        'cancel',
        NULL,
        promise_type_worker_name,
        queue_msg_id,
        'canceled',
        now()
    );

    RETURN jsonb_build_object(
        'archive_result', archive_result,
        'promise_queue_name', promise_type_worker_name,
        'queue_msg_id', queue_msg_id,
        'status', 'canceled'
    );
END;
$$ LANGUAGE plpgsql;

-- SELECT fsm_core.cancel_event_for_fsm_promise_type_worker_v2('creditCheck_v01_verifyCredentials', 1::BIGINT);
