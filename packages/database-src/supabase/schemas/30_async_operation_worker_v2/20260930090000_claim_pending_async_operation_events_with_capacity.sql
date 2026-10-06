-- Capacity-aware claim for the Activity Gateway's poll loop (SPEC-007 §5–6,
-- #396). Same row shape as
-- claim_pending_async_operation_events_for_workers_v2, which stays until
-- nothing calls it, but each actor identity in input_workers also says how
-- much to take and for how long:
--
--   qty          messages to claim at most: the gateway's free slots for the
--                actor (Σ max_concurrency − in-flight over its workers).
--                Identities with qty <= 0 are skipped.
--   vt_seconds   PGMQ visibility timeout for the claimed messages: at least
--                the invoke timeout, so a message can't be claimed again
--                while its first invoke may still be running.
--
-- Each row also carries readCount (PGMQ's read_ct), which the gateway uses to
-- stop redelivering a message whose invokes keep failing retriably (#396).
CREATE OR REPLACE FUNCTION fsm_core.claim_pending_async_operation_events_with_capacity_v2(
    input_workers jsonb
)
RETURNS SETOF jsonb
AS $$
DECLARE
    worker jsonb;
    computed_queue_name text;
    queue_exists boolean;
    claim_qty integer;
    claim_vt integer;
    msg pgmq.message_record;
BEGIN
    FOR worker IN SELECT * FROM jsonb_array_elements(input_workers)
    LOOP
        claim_qty := COALESCE((worker->>'qty')::integer, 0);
        IF claim_qty <= 0 THEN
            CONTINUE;
        END IF;
        claim_vt := GREATEST(COALESCE((worker->>'vt_seconds')::integer, 30), 1);

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
            SELECT * FROM pgmq.read(computed_queue_name, claim_vt, claim_qty)
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
                'readCount', msg.read_ct,
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
