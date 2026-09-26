-- fsm-async-worker-gateway-ts's 30-second poll loop calls this with its
-- currently-registered worker identities:
--   [{parent_fsm_name, parent_fsm_version, async_operation_type,
--     async_operation_name, async_operation_version,
--     async_operation_language}, ...]
-- (no "handler" -- that's an in-process function reference, not
-- serializable to Postgres).
--
-- For each worker identity: computes its queue name (same rule as
-- ensure_async_operation_queue_for_worker_v2, via the shared
-- fsm_core.compute_async_operation_queue_name_v2 -- see that function's own
-- doc comment in 20260806201803_ensure_async_operation_queue_for_worker.sql),
-- skips it if that queue doesn't exist yet (no queue = definitely nothing
-- pending, and pgmq.read() on a nonexistent queue would error rather than
-- return empty), and otherwise reads up to one message from it (qty=1,
-- vt=30s -- matches this codebase's existing one-message-at-a-time PGMQ read
-- convention).
--
-- Each claimed row is built with camelCase keys, not the snake_case this
-- file's own parameters use -- matching the convention already established
-- by send_event_to_async_operation_queue_with_event_logs_v2's own pgmq
-- message payload (jsonb *content* consumed directly by TS is camelCase in
-- this codebase; snake_case is for PG function parameter/column names, a
-- different thing). This is what
-- fsm-async-worker-gateway-ts/src/asyncOpPollLoop.ts's parseClaimedAsyncOperationEvent
-- expects field-for-field -- see that file for the full row shape.
--
-- Identity fields (parentFsmName etc.) come from the *worker* being
-- iterated, not the message itself -- the message payload
-- (send_event_to_async_operation_queue_with_event_logs_v2's queue_msg_data)
-- never carried the full 6-field actor identity, only a parent FSM instance
-- id (sendToParentQueueId) and queue metadata. instanceId is mapped from
-- sendToParentQueueId (the FSM instance that will receive the completion
-- event); correlationId is the message's own msg_id, stringified, since the
-- stored message has no separate correlation id field.
--
-- Does NOT compute a "xstate.done.actor."/"xstate.error.actor."-prefixed
-- eventName based on invoke outcome -- eventName here is always the raw
-- sendToParentQueueIdEventName from the message. Whether/how to
-- outcome-prefix it is a dispatchAndArchive()-side concern (TS), out of
-- scope for this change.
CREATE OR REPLACE FUNCTION fsm_core.claim_pending_async_operation_events_for_workers_v2(
    input_workers jsonb
)
RETURNS SETOF jsonb
AS $$
DECLARE
    worker jsonb;
    computed_queue_name text;
    queue_exists boolean;
    msg pgmq.message_record;
BEGIN
    FOR worker IN SELECT * FROM jsonb_array_elements(input_workers)
    LOOP
        computed_queue_name := fsm_core.compute_async_operation_queue_name_v2(
            worker->>'parent_fsm_name', worker->>'parent_fsm_version',
            worker->>'async_operation_type', worker->>'async_operation_name',
            worker->>'async_operation_version', worker->>'async_operation_language'
        );

        SELECT EXISTS (
            SELECT 1 FROM pgmq.meta WHERE queue_name = computed_queue_name
        ) INTO queue_exists;

        IF NOT queue_exists THEN
            CONTINUE;
        END IF;

        FOR msg IN
            SELECT * FROM pgmq.read(computed_queue_name, 30, 1)
        LOOP
            RETURN NEXT jsonb_build_object(
                'parentFsmName', worker->>'parent_fsm_name',
                'parentFsmVersion', worker->>'parent_fsm_version',
                'asyncOperationType', worker->>'async_operation_type',
                'asyncOperationName', worker->>'async_operation_name',
                'asyncOperationVersion', worker->>'async_operation_version',
                'asyncOperationLanguage', worker->>'async_operation_language',
                'input', msg.message->'eventData'->'eventPayload',
                'instanceId', msg.message->>'sendToParentQueueId',
                'correlationId', msg.msg_id::text,
                'asyncOperationQueueName', computed_queue_name,
                'asyncOperationQueueType', worker->>'async_operation_type',
                'asyncOperationQueueVersion', worker->>'async_operation_version',
                'msgId', msg.msg_id,
                'eventName', msg.message->>'sendToParentQueueIdEventName',
                'eventActionType', msg.message->'eventData'->>'actionType',
                'eventDelay', COALESCE((msg.message->>'queueMsgDelay')::integer, 0),
                'sendToParentQueueId', msg.message->>'sendToParentQueueId',
                'sendToParentQueueIdEventName', msg.message->>'sendToParentQueueIdEventName'
            );
        END LOOP;
    END LOOP;

    RETURN;
END;
$$ LANGUAGE plpgsql;
