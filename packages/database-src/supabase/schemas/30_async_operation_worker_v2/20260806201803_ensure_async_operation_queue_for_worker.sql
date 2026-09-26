-- Shared queue-naming logic for the async-operation-actor identity -> PGMQ
-- queue name mapping used by both ensure_async_operation_queue_for_worker_v2
-- (this file) and claim_pending_async_operation_events_for_workers_v2
-- (20260806173833_claim_pending_async_operation_events_for_workers.sql) --
-- factored out so the two functions can't drift out of sync on the naming
-- rule, which has already changed twice.
--
-- async_operation_type is shortened to its first character (e.g. "internalAsyncOperation"
-- -> "i") in all cases, and async_operation_version is dropped entirely in all cases too
-- -- for 'internalAsyncOperation' it's the child actor's own version, which
-- has no bearing on queue identity; for 'sharedAsyncOperation',
-- create-async-logic.ts's toSharedAsyncOpRegisteredActor always sets
-- async_operation_version equal to parent_fsm_version (same `version` folder value
-- passed for both), so dropping it loses nothing -- parent_fsm_version is
-- still in the name. Beyond that, each async_operation_type has one further
-- length-driven reduction: 'internalAsyncOperation' shortens async_operation_language to
-- its first character; 'sharedAsyncOperation' shortens parent_fsm_name to
-- its first character instead -- lossless there too, since
-- toSharedAsyncOpRegisteredActor always sets parent_fsm_name to the fixed
-- constant "sharedAsyncOperation" (SHARED_ASYNC_OP_PARENT_FSM_NAME), never a
-- real owning FSM's name -- a sharedAsyncOperation identity never comes from
-- a real invoke object with a distinct parent (that's what
-- 'internalAsyncOperation' is for -- see operation-logic-scaffold.ts's
-- toRegisteredActor, "the only kind" that builds it), so the full constant
-- string carried no identity information to begin with.
--
--   async_operation_type = 'internalAsyncOperation':
--     <parentFsmName>_<parentFsmVersion>_<asyncOperationType[0]>_<asyncOperationName>_<asyncOperationLanguage[0]>
--   async_operation_type = 'sharedAsyncOperation':
--     <parentFsmName[0]>_<parentFsmVersion>_<asyncOperationType[0]>_<asyncOperationName>_<asyncOperationLanguage>
--
-- Any other async_operation_type raises -- this function only names queues for the two
-- async-operation-actor identities ('internalAsyncOperation'/'sharedAsyncOperation'),
-- never 'fsm'/'sharedFsm'. Previously the "otherwise" branch silently applied
-- the sharedAsyncOperation naming to any unrecognized async_operation_type, which
-- archive_from_fsm_instance_worker_v2.sql's caller worked around by
-- validating asyncOperationType itself before calling in -- that workaround is now
-- redundant (this function raises first) but left in place there.
--
-- unlike the existing 'sharedPromise_<asyncOperationName>_<asyncOperationVersion>' convention (see
-- archive_from_fsm_instance_worker_v2.sql), this one is unique per actor
-- identity including language, matching sidecar/gateway.ts's actorKey() --
-- two workers of different languages serving the "same" actor never share a
-- queue (in the async_operation_type = 'internalAsyncOperation' case, this still holds
-- since async_operation_language is shortened, not dropped -- two languages sharing the
-- same first letter would collide, but none do among
-- typescript/python/rust/go today: t/p/r/g; in the 'sharedAsyncOperation'
-- case, shortening parent_fsm_name instead loses no identity either, per the
-- constant-value reasoning above).
--
-- PGMQ caps queue names at 48 characters -- see CLI-USAGE.md's note on this
-- limit. Still not guaranteed to fit for long parentFsmName/asyncOperationName
-- combinations even with these reductions.
CREATE OR REPLACE FUNCTION fsm_core.compute_async_operation_queue_name_v2(
    input_parent_fsm_name text,
    input_parent_fsm_version text,
    input_async_operation_type text,
    input_async_operation_name text,
    input_async_operation_version text,
    input_async_operation_language text
)
RETURNS text
AS $$
BEGIN
    IF input_async_operation_type = 'internalAsyncOperation' THEN
        RETURN input_parent_fsm_name || '_' || input_parent_fsm_version
            || '_' || LEFT(input_async_operation_type, 1) || '_' || input_async_operation_name || '_'
            || LEFT(input_async_operation_language, 1);
    ELSIF input_async_operation_type = 'sharedAsyncOperation' THEN
        RETURN LEFT(input_parent_fsm_name, 1) || '_' || input_parent_fsm_version
            || '_' || LEFT(input_async_operation_type, 1) || '_' || input_async_operation_name || '_'
            || input_async_operation_language;
    ELSE
        RAISE EXCEPTION 'compute_async_operation_queue_name_v2: unsupported input_async_operation_type: %', input_async_operation_type;
    END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Ensures a PGMQ queue exists for an async-operation-actor identity, called
-- when fsm-core-async-op-worker's SidecarGateway registers a worker (see
-- ensureQueueOnRegister in gatewayServer.ts / GOAL.md).
--
-- pgmq.create() is already fully idempotent (CREATE TABLE/INDEX IF NOT
-- EXISTS, INSERT ... ON CONFLICT DO NOTHING internally -- see
-- pgmq.create_non_partitioned()), so the only reason this function checks
-- pgmq.meta first is to report whether it already existed, not for
-- correctness -- concurrent calls for the same queue name are already safe
-- without this function's own check.
CREATE OR REPLACE FUNCTION fsm_core.ensure_async_operation_queue_for_worker_v2(
    input_parent_fsm_name text,
    input_parent_fsm_version text,
    input_async_operation_type text,
    input_async_operation_name text,
    input_async_operation_version text,
    input_async_operation_language text
)
RETURNS jsonb
AS $$
DECLARE
    computed_queue_name text;
    already_existed boolean;
BEGIN
    computed_queue_name := fsm_core.compute_async_operation_queue_name_v2(
        input_parent_fsm_name, input_parent_fsm_version, input_async_operation_type,
        input_async_operation_name, input_async_operation_version, input_async_operation_language
    );

    SELECT EXISTS (
        SELECT 1 FROM pgmq.meta WHERE queue_name = computed_queue_name
    ) INTO already_existed;

    IF NOT already_existed THEN
        PERFORM pgmq.create(computed_queue_name);
    END IF;

    RETURN jsonb_build_object(
        'queue_name', computed_queue_name,
        'already_existed', already_existed
    );
END;
$$ LANGUAGE plpgsql;
