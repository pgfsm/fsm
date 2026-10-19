set check_function_bodies = off;

-- #526: FSM-queue messages carry no reply-to (sendToParent*) any more; a
-- child FSM's parent is on its fsm_instance row (#523). Async actor messages
-- keep theirs (the Activity Gateway sends results back with them).
-- The three functions that start an invoke's async operation are renamed
-- start_* and return one entry shape, which the archive keeps and matches on
-- exit by invoke_id and src. Entries saved in total_async_operation_queue_data
-- before this version have the old shape and are not matched (development
-- data only).
ALTER TABLE fsm_core.fsm_instance_queue_event_logs
    DROP COLUMN send_to_parent_queue_id,
    DROP COLUMN send_to_parent_queue_id_event_name;

-- send_event_to_fsm_queue_with_event_logs_v2 loses its three reply-to
-- parameters: drop the old signature and re-apply its access control.
DROP FUNCTION IF EXISTS fsm_core.send_event_to_fsm_queue_with_event_logs_v2(uuid, text, text, uuid, text, text, text, text, jsonb, integer, text, jsonb, text, timestamp with time zone, integer, timestamp with time zone);

CREATE OR REPLACE FUNCTION fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
    input_fsm_instance_id uuid,
    input_fsm_instance_id_fsm_type text,
    input_fsm_instance_id_fsm_version text,
    input_event_name text,
    input_event_action_type text,
    input_event_data jsonb,
    input_event_delay integer DEFAULT 0,
    input_event_status text DEFAULT 'ACTIVE',
    input_event_output jsonb DEFAULT '{}'::jsonb,
    input_error_message text DEFAULT NULL,
    input_execution_started_at timestamp with time zone DEFAULT now(),
    input_execution_duration integer DEFAULT NULL,
    input_execution_finished_at timestamp with time zone DEFAULT now()
)
RETURNS JSONB
AS $$
DECLARE
    queue_msg_data jsonb;
    output_fsm_instance_queue_msg_id bigint;
    output_fsm_instance_queue_event_log_id uuid;
BEGIN
    IF input_fsm_instance_id IS NULL THEN
        RAISE EXCEPTION 'fsm_instance_id is NULL';
    END IF;

    queue_msg_data := jsonb_build_object(
        'eventData', jsonb_build_object(
            'eventType',    input_event_name,
            'eventPayload', input_event_data,
            'actionType',   input_event_action_type
        ),
        'queueId',                    input_fsm_instance_id,
        'queueType',                  input_fsm_instance_id_fsm_type,
        'queueVersion',               input_fsm_instance_id_fsm_version
        -- No reply-to (sendToParent*) on an FSM queue's messages: nothing reads
        -- it; a child FSM's parent is on its fsm_instance row (#523, #526).
    );

    BEGIN
        SELECT pgmq.send(queue_name := input_fsm_instance_id::text, msg := queue_msg_data, delay := input_event_delay)
        INTO output_fsm_instance_queue_msg_id;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'pgmq.send failed for queue %: %', input_fsm_instance_id, SQLERRM;
    END;

    IF output_fsm_instance_queue_msg_id IS NULL THEN
        RAISE EXCEPTION 'Failed to send event to queue %', input_fsm_instance_id;
    END IF;

    -- Append queueMsgId to queue_msg_data
    queue_msg_data := queue_msg_data || jsonb_build_object('queueMsgId', output_fsm_instance_queue_msg_id);

    -- Append queueMsgDelay to queue_msg_data
    queue_msg_data := queue_msg_data || jsonb_build_object('queueMsgDelay', input_event_delay);

    INSERT INTO fsm_core.fsm_instance_queue_event_logs (
        fsm_instance_id,
        fsm_instance_id_fsm_type,
        fsm_instance_id_fsm_version,
        fsm_instance_queue_msg_id,
        event_name,
        event_data,
        event_delay,
        execution_started_at,
        execution_duration,
        execution_finished_at,
        event_status,
        event_output,
        error_message
    ) VALUES (
        input_fsm_instance_id,
        input_fsm_instance_id_fsm_type,
        input_fsm_instance_id_fsm_version,
        output_fsm_instance_queue_msg_id,
        input_event_name,
        input_event_data,
        input_event_delay,
        input_execution_started_at,
        input_execution_duration,
        input_execution_finished_at,
        input_event_status,
        input_event_output,
        input_error_message
    ) RETURNING fsm_instance_queue_event_log_id INTO output_fsm_instance_queue_event_log_id;

    RETURN jsonb_build_object(
        'queue_data', queue_msg_data,
        'queue_event_log_id', output_fsm_instance_queue_event_log_id,
        'event_status', input_event_status,
        'event_output', input_event_output,
        'error_message', input_error_message
    );
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION fsm_core.send_event_to_fsm_queue_with_event_logs_v2(uuid, text, text, text, text, jsonb, integer, text, jsonb, text, timestamp with time zone, integer, timestamp with time zone) SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
REVOKE EXECUTE ON FUNCTION fsm_core.send_event_to_fsm_queue_with_event_logs_v2(uuid, text, text, text, text, jsonb, integer, text, jsonb, text, timestamp with time zone, integer, timestamp with time zone) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fsm_core.send_event_to_fsm_queue_with_event_logs_v2(uuid, text, text, text, text, jsonb, integer, text, jsonb, text, timestamp with time zone, integer, timestamp with time zone) TO fsm_operator;

CREATE OR REPLACE FUNCTION fsm_core.create_fsm_instance_from_name_v2(input_fsm_name text, input_fsm_version text, input_fsm_context jsonb, create_pgmq_queue boolean DEFAULT true, input_parent_fsm_instance_id uuid DEFAULT NULL::uuid, input_parent_invoke_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    output_queue_created boolean := false;
    output_message text := NULL;
    output_extra_message text := NULL;
    fsm_instance_id uuid;
    send_event_result jsonb := NULL;
    derived_fsm_type text;
    fsm_json_exists boolean;
    fsm_instance_row      fsm_core.fsm_instance;
BEGIN
    -- 1. Check if fsm_name and fsm_version exist in fsm_core.fsm_json
    SELECT EXISTS (
        SELECT 1
        FROM fsm_core.fsm_json fj
        WHERE fj.fsm_name = input_fsm_name AND fj.fsm_version = input_fsm_version
    ) INTO fsm_json_exists;

    IF NOT fsm_json_exists THEN
        RAISE EXCEPTION 'FSM with name % and version % not found in fsm_core.fsm_json', input_fsm_name, input_fsm_version;
    END IF;

    -- 1.1. Derive fsm_type from fsm_core.fsm_dependencies: a row where this FSM
    -- is a child means it's a childfsm, otherwise it's a top-level fsm.
    IF EXISTS (
        SELECT 1
        FROM fsm_core.fsm_dependencies fd
        WHERE fd.child_fsm_name = input_fsm_name AND fd.child_fsm_version = input_fsm_version
    ) THEN
        derived_fsm_type := 'childfsm';
    ELSE
        derived_fsm_type := 'fsm';
    END IF;

    -- 2. Create new fsm_instance
    INSERT INTO fsm_core.fsm_instance (fsm_name, fsm_version, fsm_type, fsm_instance_context, parent_fsm_instance_id, parent_invoke_id)
    VALUES (input_fsm_name, input_fsm_version, derived_fsm_type, input_fsm_context, input_parent_fsm_instance_id, input_parent_invoke_id)
    RETURNING * INTO fsm_instance_row;

    fsm_instance_id := fsm_instance_row.id;

    -- 3. Insert all transitions into fsm_core.fsm_instance_transitions_auth
    INSERT INTO fsm_core.fsm_instance_transitions_auth (
        fsm_name, fsm_version, fsm_type, fsm_instance_id, fsm_instance_event_type, users, groups, module_tag, meta_info
    )
    SELECT
        t.fsm_name,
        t.fsm_version,
        derived_fsm_type,
        fsm_instance_id,
        t.event_type,
        ARRAY[]::jsonb[], -- users (default empty array)
        ARRAY[]::jsonb[], -- groups (default empty array)
        NULL::jsonb,      -- module_tag (default null)
        NULL::jsonb       -- meta_info (default null)
    FROM fsm_core.fsm_transitions t
    WHERE t.fsm_name = input_fsm_name AND t.fsm_version = input_fsm_version;

    -- 4. Enqueue to fsm_instance_and_fsm_workerlet and notify the fsmscheduler.
    PERFORM fsm_core.enqueue_fsm_dispatch_v2(
        fsm_instance_id,
        input_fsm_name,
        input_fsm_version,
        'start'
    );

    -- 5. Optionally create pgmq queue and send initial event
    IF create_pgmq_queue THEN
        BEGIN
            PERFORM pgmq.create(queue_name := fsm_instance_id::text);
            output_queue_created := true;
            output_message := 'Queue created successfully.';
            -- Try to send initialTransition_event to the queue
            BEGIN
                send_event_result := fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
                    input_fsm_instance_id := fsm_instance_id,
                    input_fsm_instance_id_fsm_type := derived_fsm_type,
                    input_fsm_instance_id_fsm_version := input_fsm_version,
                    input_event_name := 'initialTransition_event',
                    input_event_action_type := 'system',
                    input_event_data := jsonb_build_object('source', 'system'),
                    input_event_delay := 0,
                    input_event_status := 'fsm_started',
                    input_event_output := '{}'::jsonb,
                    input_error_message := NULL,
                    input_execution_started_at := now(),
                    input_execution_duration := NULL,
                    input_execution_finished_at := now()
                );
                output_extra_message := 'initialTransition_event is also sent to queue.';
            EXCEPTION WHEN OTHERS THEN
                output_extra_message := SQLERRM;
            END;
        EXCEPTION WHEN OTHERS THEN
            output_queue_created := false;
            output_message := SQLERRM;
        END;
    ELSE
        output_queue_created := false;
        output_message := 'queue_created is false and no queue is created.';
        output_extra_message := NULL;
    END IF;

    RETURN jsonb_build_object(
        'queue_created', output_queue_created,
        'fsm_name', input_fsm_name,
        'fsm_version', input_fsm_version,
        'fsm_instance_id', fsm_instance_id,
        'fsm_instance_context', input_fsm_context,
        'send_event_result', send_event_result,
        'message', output_message,
        'extra_message', output_extra_message
    );
END;
$function$;

CREATE OR REPLACE FUNCTION fsm_core.archive_event_from_fsm_async_operation_type_worker_v2(input_async_operation_queue_name text, input_async_operation_queue_type text, input_async_operation_queue_version text, input_async_operation_queue_msg_id bigint, input_event_name text, input_event_action_type text, input_event_data jsonb, input_event_delay integer, input_send_to_parent_queue_id uuid, input_send_to_parent_queue_id_event_name text, input_execution_started_at timestamp with time zone, input_execution_duration integer, input_execution_finished_at timestamp with time zone, input_event_status text, input_event_output jsonb, input_error_message text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
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
$function$;

-- ============================================================
-- Starting an invoke's async operation. XState starts an invoked actor when
-- its state is entered and stops it when the state exits: enterStates
-- (packages/core/src/stateUtils.ts) turns each invoke into a
-- spawnChild(src, { id, input }) action, and executeSpawn
-- (packages/core/src/actions/spawnChild.ts) starts what src names. Archive
-- step 6 does the same with start_invoked_async_operation_v2, which starts
-- either kind of async operation by its asyncOperationType:
--   start_async_operation_for_worker_v2  internal/sharedAsyncOperation, run
--                                        by a polyglot worker through the
--                                        Activity Gateway
--   start_child_fsm_v2                   fsm, a child machine: a real
--                                        fsm_instance
-- The names say "start", not "spawn": in XState a spawned actor lives until
-- it is stopped, while an invoked one lives only as long as its state, which
-- is what these are. Renamed in #526 from
-- send_event_to_queue_from_fsm_instance_id_v2,
-- create_async_op_queue_and_send_event_from_fsm_instance_id_v2 and
-- create_child_fsm_instance_from_invoke_v2.
--
-- All three return the same entry, which the archive keeps in
-- fsm_instance.total_async_operation_queue_data:
--   {
--     "invoke_id":            the invoke's id (XState's actor id),
--     "src":                  the invoke's src,
--     "async_operation_type": internalAsyncOperation | sharedAsyncOperation | fsm,
--     "queue_id":             where it runs: the async operation's queue, or
--                             the child's instance id,
--     "queue_msg_id":         the message that starts it,
--     "queue_event_log_id":   that message's event log row,
--     "queue_data":           the message, as sent
--   }
-- When the invoking state exits, the archive finds the entry by invoke_id and
-- src (step 2), as XState stops the child with that id, and cancels its
-- queue_msg_id on queue_id (step 4). Before #526 the child FSM's result had no
-- queue_data, so step 6 appended NULL and wiped the parent's whole list.
-- ============================================================


-- ============================================================
-- 1. start_async_operation_for_worker_v2
--    Sends the invoke to its async operation's queue, creating the queue
--    the first time.
-- ============================================================
DROP FUNCTION IF EXISTS fsm_core.create_async_op_queue_and_send_event_from_fsm_instance_id_v2(text, jsonb, text, text, text, text, text, text, text, text, uuid);
DROP FUNCTION IF EXISTS fsm_core.create_async_op_queue_and_send_event_from_fsm_instance_id_v2(text, jsonb, text, text, text, text, text, text, text, text, text, uuid);
-- Queue naming delegates to fsm_core.compute_async_operation_queue_name_v2
-- (30_async_operation_worker_v2/20260806201803_ensure_async_operation_queue_for_worker.sql,
-- loaded before this file) instead of computing it inline, so this function
-- and fsm-async-worker-gateway-ts's poll loop (claim_pending_async_operation_events_for_workers_v2,
-- same shared helper) can never drift onto different queue names for the
-- same async operation again.
--
-- compute_async_operation_queue_name_v2 also validates async_operation_type itself and
-- raises on anything outside internalAsyncOperation/sharedAsyncOperation (see
-- its own doc comment) -- the check below is redundant against that but kept
-- so this function fails with its own, call-site-specific message rather than
-- relying on the shared helper's.
CREATE OR REPLACE FUNCTION fsm_core.start_async_operation_for_worker_v2(
    invoke_id text,
    src text,
    input jsonb,
    action_type text,
    async_operation_type text,
    async_operation_version text,
    async_operation_language text,
    parent_fsm_instance_id uuid,
    parent_fsm_name text,
    parent_fsm_version text
) RETURNS jsonb AS $$
DECLARE
    async_operation_queue_name text;
    send_result jsonb;
BEGIN
    IF async_operation_type NOT IN ('internalAsyncOperation', 'sharedAsyncOperation') THEN
        RAISE EXCEPTION 'start_async_operation_for_worker_v2: unsupported async operation type: %', async_operation_type;
    END IF;

    async_operation_queue_name := fsm_core.compute_async_operation_queue_name_v2(
        parent_fsm_name, parent_fsm_version, async_operation_type, src, async_operation_version, async_operation_language
    );

    IF NOT EXISTS (
        SELECT 1 FROM pgmq.list_queues() q WHERE q.queue_name = async_operation_queue_name
    ) THEN
        PERFORM pgmq.create(queue_name := async_operation_queue_name);
    END IF;

    -- The message keeps its reply-to: the gateway sends the operation's result
    -- to sendToParentQueueId as xstate.done.actor.<sendToParentQueueIdEventName>.
    send_result := fsm_core.send_event_to_async_operation_queue_with_event_logs_v2(
        input_async_operation_queue_name := async_operation_queue_name,
        input_async_operation_fn_name := src,
        input_async_operation_queue_type := async_operation_type,
        input_async_operation_queue_version := async_operation_version,
        input_send_to_parent_queue_id := parent_fsm_instance_id,
        input_send_to_parent_queue_type := 'FSM',
        input_send_to_parent_queue_id_event_name := invoke_id,
        input_event_name := invoke_id,
        input_event_action_type := action_type,
        input_event_data := input,
        input_event_delay := 0,
        input_event_status := 'async_operation_started',
        input_event_output := '{}'::jsonb,
        input_error_message := NULL
    );

    RETURN jsonb_build_object(
        'invoke_id', invoke_id,
        'src', src,
        'async_operation_type', async_operation_type,
        'queue_id', async_operation_queue_name,
        'queue_msg_id', send_result->'queue_data'->'queueMsgId',
        'queue_event_log_id', send_result->'queue_event_log_id',
        'queue_data', send_result->'queue_data'
    );
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- 2. start_child_fsm_v2
--    An invoke of another machine: creates the child FSM instance
--    (create_fsm_instance_from_name_v2 also sends its start event).
-- ============================================================
DROP FUNCTION IF EXISTS fsm_core.create_fsm_queue_and_send_event_from_fsm_instance_id_v2(text, jsonb, text, text, text, text, text, text, text, text, uuid);
DROP FUNCTION IF EXISTS fsm_core.create_child_fsm_instance_from_invoke_v2(text, jsonb, text, text, text, uuid);
CREATE OR REPLACE FUNCTION fsm_core.start_child_fsm_v2(
    invoke_id text,
    src text,
    input jsonb,
    fsm_name text,
    fsm_version text,
    parent_fsm_instance_id uuid
) RETURNS jsonb AS $$
-- An invoked machine is a child actor in XState; here it is a real
-- fsm_instance, created like any other (its row, transition rows, dispatch to
-- an fsmlet, queue and initialTransition_event) with this instance recorded as
-- its parent and invoke_id as its invoke id, so the parent is told when it
-- finishes (archive step 9, #523). Before, only a queue was made: no row (the
-- event log's foreign key failed the parent's archive), no dispatch, and the
-- invoke id was sent as the child's first event.
DECLARE
    create_result jsonb;
BEGIN
    create_result := fsm_core.create_fsm_instance_from_name_v2(
        input_fsm_name := fsm_name,
        input_fsm_version := fsm_version,
        input_fsm_context := COALESCE(input, '{}'::jsonb),
        create_pgmq_queue := true,
        input_parent_fsm_instance_id := parent_fsm_instance_id,
        input_parent_invoke_id := invoke_id
    );
    IF NOT COALESCE((create_result->>'queue_created')::boolean, false) THEN
        RAISE EXCEPTION 'child FSM %@% (invoke %) was created without a queue: %',
            fsm_name, fsm_version, invoke_id, create_result->>'message';
    END IF;

    -- On exit the parent's archive cancels the child's start event if it is
    -- still queued. Stopping a child that is already running is a follow-up
    -- (#514).
    RETURN jsonb_build_object(
        'invoke_id', invoke_id,
        'src', src,
        'async_operation_type', 'fsm',
        'queue_id', create_result->>'fsm_instance_id',
        'queue_msg_id', create_result->'send_event_result'->'queue_data'->'queueMsgId',
        'queue_event_log_id', create_result->'send_event_result'->'queue_event_log_id',
        'queue_data', create_result->'send_event_result'->'queue_data'
    );
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- 3. start_invoked_async_operation_v2
--    Starts the async operation an invoke's src names, by its type.
-- ============================================================
DROP FUNCTION IF EXISTS fsm_core.send_event_to_queue_from_fsm_instance_id_v2(text, jsonb, text, text, text, text, text, text, text, text, uuid);
DROP FUNCTION IF EXISTS fsm_core.send_event_to_queue_from_fsm_instance_id_v2(text, jsonb, text, text, text, text, text, text, text, text, text, uuid);
CREATE OR REPLACE FUNCTION fsm_core.start_invoked_async_operation_v2(
    invoke_id text,
    src text,
    input jsonb,
    action_type text,
    async_operation_type text,
    async_operation_version text,
    async_operation_language text,
    parent_fsm_instance_id uuid,
    parent_fsm_name text,
    parent_fsm_version text
) RETURNS jsonb AS $$
BEGIN
    IF async_operation_type IN ('internalAsyncOperation', 'sharedAsyncOperation') THEN
        RETURN fsm_core.start_async_operation_for_worker_v2(
            invoke_id := invoke_id,
            src := src,
            input := input,
            action_type := action_type,
            async_operation_type := async_operation_type,
            async_operation_version := async_operation_version,
            async_operation_language := async_operation_language,
            parent_fsm_instance_id := parent_fsm_instance_id,
            parent_fsm_name := parent_fsm_name,
            parent_fsm_version := parent_fsm_version
        );
    ELSIF async_operation_type = 'fsm' THEN
        -- A child FSM: a real instance with this one as its parent (#523).
        -- src names the child machine.
        RETURN fsm_core.start_child_fsm_v2(
            invoke_id := invoke_id,
            src := src,
            input := input,
            fsm_name := src,
            fsm_version := async_operation_version,
            parent_fsm_instance_id := parent_fsm_instance_id
        );
    ELSE
        RAISE EXCEPTION 'start_invoked_async_operation_v2: unsupported async operation type: %', async_operation_type;
    END IF;
END;
$$ LANGUAGE plpgsql;

REVOKE EXECUTE ON FUNCTION fsm_core.start_async_operation_for_worker_v2(text, text, jsonb, text, text, text, text, uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fsm_core.start_child_fsm_v2(text, text, jsonb, text, text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fsm_core.start_invoked_async_operation_v2(text, text, jsonb, text, text, text, text, uuid, text, text) FROM PUBLIC;

-- archive_event_from_fsm_type_worker_v2: saves one macrostep. The worker
-- passes the scheduled events and invokes to stop and to start, as items
-- from the compiled actions (each with its id; an invoke also with its src),
-- and the instance's current totals; the entries in those totals are what
-- send_event_to_fsm_queue_with_event_logs_v2 (schedules) and
-- start_invoked_async_operation_v2 (invokes) returned.
-- The reply-to parameters (send_to_parent_queue_id, _type, _event_name) are
-- gone: a parent is read from this instance's row (step 9, #523, #526).
DROP FUNCTION IF EXISTS fsm_core.archive_event_from_fsm_type_worker_v2(
  text, bigint, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, uuid, text, text
);
CREATE OR REPLACE FUNCTION fsm_core.archive_event_from_fsm_type_worker_v2(
  remove_from_current_fsm_instance_queue_id text,
  remove_current_queue_msg_id bigint,
  to_be_removed_schedule_queue_msg_ids jsonb,
  to_be_removed_async_operation_queue_msg_ids jsonb,
  to_be_added_schedule_queue_data jsonb,
  to_be_added_async_operation_queue_data jsonb,
  input_total_schedule_queue_data jsonb,
  input_total_async_operation_queue_data jsonb,
  fsm_instance_data_save_fsm_status jsonb,
  fsm_instance_data_save_fsm_state jsonb,
  fsm_instance_data_save_fsm_context jsonb,
  fsm_instance_data_save_fsm_xstate_state jsonb
) RETURNS jsonb AS $$
DECLARE
    i int;

    schedule_queue_entry jsonb;
    remove_schedule boolean;
    schedule_queue_message jsonb;
    confirmed_removed_schedule_queue_data jsonb[] := '{}';
    confirmed_match_for_schedule boolean;
    not_confirmed_removed_schedule_queue_data jsonb[] := '{}';

    async_operation_queue_entry jsonb;
    remove_async_operation boolean;
    async_operation_queue_message jsonb;
    confirmed_removed_async_operation_queue_data jsonb[] := '{}';
    confirmed_match_for_async_operation boolean;
    not_confirmed_removed_async_operation_queue_data jsonb[] := '{}';

    to_be_added_schedule_queue_data_entry jsonb;
    to_be_added_schedule_queue_data_entry_delay int;
    output_schedule_result jsonb;

    to_be_added_async_operation_queue_data_entry jsonb;
    output_async_operation_result jsonb;

    new_total_schedule_queue_data jsonb := '[]'::jsonb;
    new_total_async_operation_queue_data jsonb := '[]'::jsonb;

    confirmed_removed_schedule_queue_data_success jsonb[] := '{}';
    confirmed_removed_schedule_queue_data_failed jsonb[] := '{}';

    confirmed_removed_async_operation_queue_data_success jsonb[] := '{}';
    confirmed_removed_async_operation_queue_data_failed jsonb[] := '{}';

    added_schedule_queue_data jsonb[] := '{}';
    added_async_operation_queue_data jsonb[] := '{}';
    parent_notify_result jsonb;
    child_parent_fsm_instance_id uuid;
    child_parent_invoke_id text;
    child_parent_fsm_name text;
    child_parent_fsm_version text;
BEGIN
    -- 1. Remove the cancelled scheduled events from input_total_schedule_queue_data
    -- A = 'input_total_schedule_queue_data'
    -- B = 'to_be_removed_schedule_queue_msg_ids'
    -- C = 'confirmed_removed_schedule_queue_data' (used for canceling events) ( C = A intersect B )
    -- D = 'not_confirmed_removed_schedule_queue_data' (used for returning to caller) ( D = B - C )
    IF input_total_schedule_queue_data IS NOT NULL THEN
        new_total_schedule_queue_data := '[]'::jsonb;
        FOR schedule_queue_entry IN
            SELECT value FROM jsonb_array_elements(input_total_schedule_queue_data) value
        LOOP
            remove_schedule := false;
            -- The scheduled event being processed now has fired: drop its entry
            -- (its message is archived below as the current one, #516).
            CONTINUE WHEN (schedule_queue_entry->'queue_data'->>'queueMsgId')::bigint = remove_current_queue_msg_id;
            IF to_be_removed_schedule_queue_msg_ids IS NOT NULL THEN
                FOR i IN 0 .. jsonb_array_length(to_be_removed_schedule_queue_msg_ids)-1 LOOP
                    schedule_queue_message := to_be_removed_schedule_queue_msg_ids->i;

                    -- A cancel names the scheduled event (`id`, e.g.
                    -- xstate.after.1000.<state id>); an entry is what
                    -- send_event_to_fsm_queue_with_event_logs_v2 returned when it was
                    -- scheduled. The old keys (event.send_event_name_to_parent_queue_id,
                    -- schedule_queue_name) were never in an entry, so nothing was ever
                    -- cancelled (#516).
                    IF (
                        (schedule_queue_entry->'queue_data'->'eventData'->>'eventType')::text = (schedule_queue_message->>'id')::text
                    ) THEN
                        remove_schedule := true;

                        EXIT;
                    END IF;
                END LOOP;
            END IF;

            IF remove_schedule THEN
                confirmed_removed_schedule_queue_data := array_append(confirmed_removed_schedule_queue_data, schedule_queue_entry);
            ELSE
                -- jsonb, not a SQL array: append with || (array_append failed on every
                -- result, #495).
                new_total_schedule_queue_data := new_total_schedule_queue_data || jsonb_build_array(schedule_queue_entry);
            END IF;
        END LOOP;
    END IF;

    -- 1b. Derive not_confirmed_removed_schedule_queue_data
    -- D = B - C => not_confirmed_removed_schedule_queue_data = to_be_removed_schedule_queue_msg_ids - confirmed_removed_schedule_queue_data
    IF to_be_removed_schedule_queue_msg_ids IS NOT NULL THEN
        FOR i IN 0 .. jsonb_array_length(to_be_removed_schedule_queue_msg_ids)-1 LOOP
            schedule_queue_message := to_be_removed_schedule_queue_msg_ids->i;
            confirmed_match_for_schedule := false;
            FOREACH schedule_queue_entry IN ARRAY confirmed_removed_schedule_queue_data LOOP
                IF (
                    (schedule_queue_entry->'queue_data'->'eventData'->>'eventType')::text = (schedule_queue_message->>'id')::text
                ) THEN
                    confirmed_match_for_schedule := true;
                    EXIT;
                END IF;
            END LOOP;

            IF NOT confirmed_match_for_schedule THEN
                not_confirmed_removed_schedule_queue_data := array_append(not_confirmed_removed_schedule_queue_data, schedule_queue_message);
            END IF;
        END LOOP;
    END IF;


    -- 2. Remove the stopped invokes from input_total_async_operation_queue_data
    -- A = 'input_total_async_operation_queue_data'
    -- B = 'to_be_removed_async_operation_queue_msg_ids'
    -- C = 'confirmed_removed_async_operation_queue_data' (used for canceling events) ( C = A intersect B )
    -- D = 'not_confirmed_removed_async_operation_queue_data' (used for returning to caller) ( D = B - C )
    IF input_total_async_operation_queue_data IS NOT NULL THEN
        new_total_async_operation_queue_data := '[]'::jsonb;
        FOR async_operation_queue_entry IN
            SELECT value FROM jsonb_array_elements(input_total_async_operation_queue_data) value
        LOOP
            remove_async_operation := false;
            IF to_be_removed_async_operation_queue_msg_ids IS NOT NULL THEN
                FOR i IN 0 .. jsonb_array_length(to_be_removed_async_operation_queue_msg_ids)-1 LOOP
                    async_operation_queue_message := to_be_removed_async_operation_queue_msg_ids->i;

                    IF (
                        -- The invoke being stopped, by its id and src (an entry from
                        -- start_invoked_async_operation_v2, #526).
                        async_operation_queue_entry->>'invoke_id' = async_operation_queue_message->>'id'
                        AND async_operation_queue_entry->>'src' = async_operation_queue_message->>'src'
                    ) THEN
                        remove_async_operation := true;

                        EXIT;
                    END IF;
                END LOOP;
            END IF;

            IF remove_async_operation THEN
                confirmed_removed_async_operation_queue_data := array_append(confirmed_removed_async_operation_queue_data, async_operation_queue_entry);
            ELSE
                -- jsonb, not a SQL array: append with || (#495).
                new_total_async_operation_queue_data := new_total_async_operation_queue_data || jsonb_build_array(async_operation_queue_entry);
            END IF;
        END LOOP;
    END IF;

    -- 2b. Derive not_confirmed_removed_async_operation_queue_data
    -- D = B - C => not_confirmed_removed_async_operation_queue_data = to_be_removed_async_operation_queue_msg_ids - confirmed_removed_async_operation_queue_data
    IF to_be_removed_async_operation_queue_msg_ids IS NOT NULL THEN
        FOR i IN 0 .. jsonb_array_length(to_be_removed_async_operation_queue_msg_ids)-1 LOOP
            async_operation_queue_message := to_be_removed_async_operation_queue_msg_ids->i;
            confirmed_match_for_async_operation := false;
            FOREACH async_operation_queue_entry IN ARRAY confirmed_removed_async_operation_queue_data LOOP
                IF (
                    async_operation_queue_entry->>'invoke_id' = async_operation_queue_message->>'id'
                    AND async_operation_queue_entry->>'src' = async_operation_queue_message->>'src'
                ) THEN
                    confirmed_match_for_async_operation := true;
                    EXIT;
                END IF;
            END LOOP;

            IF NOT confirmed_match_for_async_operation THEN
                not_confirmed_removed_async_operation_queue_data := array_append(not_confirmed_removed_async_operation_queue_data, async_operation_queue_message);
            END IF;
        END LOOP;
    END IF;

    -- 3. Remove schedule queue messages.
    IF confirmed_removed_schedule_queue_data IS NOT NULL THEN
        FOR i IN 1 .. COALESCE(array_length(confirmed_removed_schedule_queue_data, 1), 0) LOOP
            schedule_queue_entry := confirmed_removed_schedule_queue_data[i];
            -- The scheduled message's id, as stored when it was sent (#516).
            PERFORM pgmq.archive(queue_name := remove_from_current_fsm_instance_queue_id, msg_id := (schedule_queue_entry->'queue_data'->>'queueMsgId')::bigint);
            confirmed_removed_schedule_queue_data_success := array_append(confirmed_removed_schedule_queue_data_success, schedule_queue_entry);
        END LOOP;
    END IF;

    -- 4. Cancel the stopped invokes' start messages: on the async operation's
    --    queue, or a child FSM's start event on its own queue.
    IF confirmed_removed_async_operation_queue_data IS NOT NULL THEN
        FOR i IN 1 .. COALESCE(array_length(confirmed_removed_async_operation_queue_data, 1), 0) LOOP
            async_operation_queue_entry := confirmed_removed_async_operation_queue_data[i];
            PERFORM fsm_core.cancel_event_for_fsm_async_operation_type_worker_v2(
                async_operation_type_worker_name := async_operation_queue_entry->>'queue_id',
                queue_msg_id := (async_operation_queue_entry->>'queue_msg_id')::bigint
            );
            confirmed_removed_async_operation_queue_data_success := array_append(confirmed_removed_async_operation_queue_data_success, async_operation_queue_entry);
        END LOOP;
    END IF;

    -- 5. Schedule the new delayed events and collect their entries
    IF to_be_added_schedule_queue_data IS NOT NULL THEN
        FOR i IN 0 .. jsonb_array_length(to_be_added_schedule_queue_data)-1 LOOP
            to_be_added_schedule_queue_data_entry := to_be_added_schedule_queue_data->i;
            to_be_added_schedule_queue_data_entry_delay := COALESCE((to_be_added_schedule_queue_data_entry->>'delay')::integer, 0) / 1000;
            output_schedule_result := fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
                input_fsm_instance_id := remove_from_current_fsm_instance_queue_id::uuid,
                input_fsm_instance_id_fsm_type := to_be_added_schedule_queue_data_entry->>'fsmType',
                input_fsm_instance_id_fsm_version := to_be_added_schedule_queue_data_entry->>'fsmVersion',
                input_event_name := to_be_added_schedule_queue_data_entry->>'id',
                input_event_action_type := to_be_added_schedule_queue_data_entry->>'action_type',
                input_event_data := to_be_added_schedule_queue_data_entry->'input',
                input_event_delay := to_be_added_schedule_queue_data_entry_delay,
                input_event_status := 'ACTIVE',
                input_event_output := '{}'::jsonb,
                input_error_message := NULL
            );
            added_schedule_queue_data := array_append(added_schedule_queue_data, output_schedule_result);
            new_total_schedule_queue_data := new_total_schedule_queue_data || output_schedule_result;
        END LOOP;
    END IF;

    -- 6. Start the invokes of the states entered, as XState's spawnChild
    --    does (#526), and collect their entries; each is kept until its
    --    invoking state exits.
    IF to_be_added_async_operation_queue_data IS NOT NULL THEN
        FOR i IN 0 .. jsonb_array_length(to_be_added_async_operation_queue_data)-1 LOOP
            to_be_added_async_operation_queue_data_entry := to_be_added_async_operation_queue_data->i;
            output_async_operation_result := fsm_core.start_invoked_async_operation_v2(
                invoke_id := to_be_added_async_operation_queue_data_entry->>'id',
                src := to_be_added_async_operation_queue_data_entry->>'src',
                input := to_be_added_async_operation_queue_data_entry->'input',
                action_type := to_be_added_async_operation_queue_data_entry->>'action_type',
                async_operation_type := to_be_added_async_operation_queue_data_entry->>'asyncOperationType',
                async_operation_version := to_be_added_async_operation_queue_data_entry->>'asyncOperationVersion',
                async_operation_language := to_be_added_async_operation_queue_data_entry->>'asyncOperationLanguage',
                parent_fsm_instance_id := remove_from_current_fsm_instance_queue_id::uuid,
                parent_fsm_name := to_be_added_async_operation_queue_data_entry->>'parentFsmName',
                parent_fsm_version := to_be_added_async_operation_queue_data_entry->>'parentFsmVersion'
            );
            added_async_operation_queue_data := array_append(added_async_operation_queue_data, output_async_operation_result);
            new_total_async_operation_queue_data := new_total_async_operation_queue_data || jsonb_build_array(output_async_operation_result);
        END LOOP;
    END IF;

    -- 7. Save the instance: its new totals, status, state, context and XState snapshot
    UPDATE fsm_core.fsm_instance
    SET
        total_schedule_queue_data = new_total_schedule_queue_data,
        total_async_operation_queue_data = new_total_async_operation_queue_data,
        fsm_instance_status = fsm_instance_data_save_fsm_status,
        fsm_instance_state = fsm_instance_data_save_fsm_state,
        fsm_instance_context = fsm_instance_data_save_fsm_context,
        fsm_instance_xstate_state = fsm_instance_data_save_fsm_xstate_state
    WHERE id = remove_from_current_fsm_instance_queue_id::uuid;

    -- 8. Archive the message this macrostep processed
    PERFORM pgmq.archive(queue_name := remove_from_current_fsm_instance_queue_id, msg_id := remove_current_queue_msg_id::bigint);

    -- 9. If this instance was invoked by a parent FSM and has finished, tell the
    --    parent, as XState does for a child actor (#523):
    --    xstate.done.actor.<invoke id> when done, xstate.error.actor.<invoke id>
    --    on error, nothing when stopped. The parent comes from this instance's row
    --    (set when it was invoked): the message processed now is usually not the
    --    one that started it.
    SELECT fi.parent_fsm_instance_id, fi.parent_invoke_id
    INTO child_parent_fsm_instance_id, child_parent_invoke_id
    FROM fsm_core.fsm_instance fi
    WHERE fi.id = remove_from_current_fsm_instance_queue_id::uuid;

    IF child_parent_fsm_instance_id IS NOT NULL
        AND (fsm_instance_data_save_fsm_status #>> '{}') IN ('done', 'completed', 'final', 'error')
    THEN
        SELECT p.fsm_name, p.fsm_version
        INTO child_parent_fsm_name, child_parent_fsm_version
        FROM fsm_core.fsm_instance p
        WHERE p.id = child_parent_fsm_instance_id;

        parent_notify_result := fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
            input_fsm_instance_id              := child_parent_fsm_instance_id,
            input_fsm_instance_id_fsm_type     := child_parent_fsm_name,
            input_fsm_instance_id_fsm_version  := child_parent_fsm_version,
            input_event_name                   := CASE
                                                      WHEN (fsm_instance_data_save_fsm_status #>> '{}') = 'error'
                                                      THEN 'xstate.error.actor.'
                                                      ELSE 'xstate.done.actor.'
                                                  END || child_parent_invoke_id,
            input_event_action_type            := 'childFsm_completed',
            input_event_data                   := fsm_instance_data_save_fsm_context,
            input_event_delay                  := 0,
            input_event_status                 := 'ACTIVE',
            input_event_output                 := '{}'::jsonb,
            input_error_message                := NULL
        );
    END IF;

    RETURN jsonb_build_object(
         'confirmed_removed_schedule_queue_data_success', confirmed_removed_schedule_queue_data_success,
         'confirmed_removed_async_operation_queue_data_success', confirmed_removed_async_operation_queue_data_success,

         'confirmed_removed_schedule_queue_data_failed', confirmed_removed_schedule_queue_data_failed,
         'confirmed_removed_async_operation_queue_data_failed', confirmed_removed_async_operation_queue_data_failed,

         'not_confirmed_removed_schedule_queue_data', not_confirmed_removed_schedule_queue_data,
         'not_confirmed_removed_async_operation_queue_data', not_confirmed_removed_async_operation_queue_data,

         'added_schedule_queue_data', added_schedule_queue_data,
         'added_async_operation_queue_data', added_async_operation_queue_data,

         'new_total_schedule_queue_data', new_total_schedule_queue_data,
         'new_total_async_operation_queue_data', new_total_async_operation_queue_data,

         'old_total_schedule_queue_data', input_total_schedule_queue_data,
         'old_total_async_operation_queue_data', input_total_async_operation_queue_data,
         'parent_notify_result', parent_notify_result
      );

END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION fsm_core.archive_event_from_fsm_type_worker_v2(text, bigint, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
REVOKE EXECUTE ON FUNCTION fsm_core.archive_event_from_fsm_type_worker_v2(text, bigint, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fsm_core.archive_event_from_fsm_type_worker_v2(text, bigint, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) TO fsm_worker;
