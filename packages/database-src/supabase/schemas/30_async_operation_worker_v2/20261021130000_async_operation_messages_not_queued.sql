-- async_operation_messages_not_queued_v2 (SPEC-012 (b), #538): the Activity
-- Gateway's sweep. Given the (queue_name, msg_id) pairs of the invokes it is
-- running, returns those no longer on their pgmq queues.
--
-- While a worker runs an invoke its message stays on the queue, invisible
-- (the gateway claims with a visibility timeout, not a delete). Its result
-- archives it through finish_async_operation_event_v2, but only through this
-- same gateway, and only after the invoke is no longer pending. So a pending
-- invoke's message that is gone was archived by a cancel: its FSM state
-- exited (stop_invoked_async_operation_v2, #533/#534). The gateway then
-- cancels the invoke (Cancel{STATE_EXITED}). The sweep is the backstop for a
-- missed fsm_async_operation_cancel notification (NOTIFY is at most once, and
-- LISTEN doesn't work through a transaction pooler), and the only detection
-- when the gateway has no direct connection to LISTEN on.
--
-- input_messages: [{"queue_name": text, "msg_id": bigint}, ...]
-- Returns the same shape, for the pairs not found. A queue that no longer
-- exists counts as not found. One query per distinct queue.
CREATE OR REPLACE FUNCTION fsm_core.async_operation_messages_not_queued_v2(
    input_messages jsonb
) RETURNS jsonb AS $$
DECLARE
    queue record;
    present bigint[];
    missing jsonb := '[]'::jsonb;
BEGIN
    FOR queue IN
        SELECT m->>'queue_name' AS queue_name,
               array_agg((m->>'msg_id')::bigint) AS msg_ids
        FROM jsonb_array_elements(COALESCE(input_messages, '[]'::jsonb)) m
        GROUP BY m->>'queue_name'
    LOOP
        IF EXISTS (SELECT 1 FROM pgmq.list_queues() q WHERE q.queue_name = queue.queue_name) THEN
            EXECUTE format(
                'SELECT COALESCE(array_agg(msg_id), ''{}'') FROM pgmq.%I WHERE msg_id = ANY($1)',
                pgmq.format_table_name(queue.queue_name, 'q')
            ) INTO present USING queue.msg_ids;
        ELSE
            present := '{}';
        END IF;

        SELECT missing || COALESCE(jsonb_agg(jsonb_build_object('queue_name', queue.queue_name, 'msg_id', id)), '[]'::jsonb)
        INTO missing
        FROM unnest(queue.msg_ids) id
        WHERE id <> ALL (present);
    END LOOP;
    RETURN missing;
END;
$$ LANGUAGE plpgsql;
