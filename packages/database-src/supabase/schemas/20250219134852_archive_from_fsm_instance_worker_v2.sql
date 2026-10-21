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
-- src (step 5b), as XState stops the child with that id, and stops it with
-- stop_invoked_async_operation_v2 (below). Before #526 the child FSM's result
-- had no queue_data, so the archive appended NULL and wiped the parent's
-- whole list.
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

    -- When the invoking state exits, the parent's archive stops the child,
    -- running or not, with stop_child_fsm_v2 (#534).
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


-- ============================================================
-- Stopping an invoke (SPEC-011, #534). XState stops an invoked actor when
-- its state exits (exitStates turns each invoke into stopChild(id)), and
-- stopping an actor stops its whole subtree and cancels its delayed events;
-- a stopped actor sends its parent nothing. The mirror of the starting
-- functions above:
--   stop_invoked_async_operation_v2   dispatches on the entry's
--                                     async_operation_type
--   stop_child_fsm_v2                 fsm: stops the child instance
--   stop_fsm_instance_v2              stops any instance and its subtree
-- Lock order: a caller holds its own instance row and locks only rows below
-- it (child, then grandchildren). Rows are locked FOR NO KEY UPDATE, never
-- FOR UPDATE: every event-log insert for an instance takes FOR KEY SHARE on
-- it through the log's foreign key, and FOR UPDATE would make a child that is
-- notifying its parent and a parent that is stopping that child deadlock.
-- ============================================================

-- Archives every message on an instance's own queue (pending events, delayed
-- events, and one an fsmlet may be processing right now) and returns their
-- ids. Archived rather than purged, to keep the audit trail.
CREATE OR REPLACE FUNCTION fsm_core.archive_fsm_instance_queue_messages_v2(
    input_fsm_instance_id uuid
) RETURNS bigint[] AS $$
DECLARE
    instance_queue_name text := input_fsm_instance_id::text;
    queued_msg_ids bigint[];
    archived_msg_ids bigint[] := '{}';
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pgmq.list_queues() q WHERE q.queue_name = instance_queue_name) THEN
        RETURN archived_msg_ids;
    END IF;
    EXECUTE format('SELECT COALESCE(array_agg(msg_id ORDER BY msg_id), ''{}'') FROM pgmq.%I', 'q_' || instance_queue_name)
    INTO queued_msg_ids;
    IF cardinality(queued_msg_ids) > 0 THEN
        SELECT COALESCE(array_agg(a ORDER BY a), '{}') INTO archived_msg_ids
        FROM pgmq.archive(instance_queue_name, queued_msg_ids) a;
    END IF;
    RETURN archived_msg_ids;
END;
$$ LANGUAGE plpgsql;


CREATE OR REPLACE FUNCTION fsm_core.stop_fsm_instance_v2(
    input_fsm_instance_id uuid,
    input_event_name text DEFAULT 'stop_fsm_instance'
) RETURNS jsonb AS $$
DECLARE
    instance_row fsm_core.fsm_instance%ROWTYPE;
    cancelled_dispatch_count integer;
    archived_msg_ids bigint[];
    invoke_entry jsonb;
    stopped_invokes jsonb := '[]'::jsonb;
    event_log_id uuid;
BEGIN
    -- 1. Lock the instance. Already finished or stopped: nothing to do.
    SELECT * INTO instance_row
    FROM fsm_core.fsm_instance
    WHERE id = input_fsm_instance_id
    FOR NO KEY UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'fsm_not_found', 'fsm_instance_id', input_fsm_instance_id);
    END IF;
    IF COALESCE(instance_row.fsm_instance_status #>> '{}', 'active') <> 'active' THEN
        RETURN jsonb_build_object(
            'status', 'not_active',
            'fsm_instance_id', input_fsm_instance_id,
            'fsm_instance_status', instance_row.fsm_instance_status
        );
    END IF;

    -- 2. Stopped, with nothing left to process. A macrostep that is in flight
    --    finds this status when it takes the lock, and is discarded.
    UPDATE fsm_core.fsm_instance
    SET fsm_instance_status = '"stopped"'::jsonb,
        internal_event_queue = '[]'::jsonb,
        internal_event_count = 0,
        total_schedule_queue_data = '[]'::jsonb,
        total_async_operation_queue_data = '[]'::jsonb
    WHERE id = input_fsm_instance_id;

    -- 3. No fsmlet is given it again.
    DELETE FROM fsm_core.fsm_instance_and_fsm_workerlet
    WHERE fsm_instance_id = input_fsm_instance_id
      AND status IN ('pending', 'scheduled');
    GET DIAGNOSTICS cancelled_dispatch_count = ROW_COUNT;

    -- 4. Every message on its queue, delayed events included, is archived.
    --    Then one xstate.stop message wakes an fsmlet that is waiting on the
    --    empty queue: it sees the status and lets the instance go.
    archived_msg_ids := fsm_core.archive_fsm_instance_queue_messages_v2(input_fsm_instance_id);
    IF EXISTS (SELECT 1 FROM pgmq.list_queues() q WHERE q.queue_name = input_fsm_instance_id::text) THEN
        PERFORM pgmq.send(
            queue_name := input_fsm_instance_id::text,
            msg := jsonb_build_object(
                'eventData', jsonb_build_object(
                    'eventType', 'xstate.stop',
                    'eventPayload', '{}'::jsonb,
                    'actionType', 'stop'
                ),
                'queueId', input_fsm_instance_id,
                'queueType', instance_row.fsm_name,
                'queueVersion', instance_row.fsm_version
            )
        );
    END IF;

    -- 5. Its own invokes stop too: actors, and child machines recursively.
    FOR invoke_entry IN
        SELECT value FROM jsonb_array_elements(COALESCE(instance_row.total_async_operation_queue_data, '[]'::jsonb)) value
    LOOP
        stopped_invokes := stopped_invokes || jsonb_build_array(
            fsm_core.stop_invoked_async_operation_v2(invoke_entry)
        );
    END LOOP;

    -- 6. Log it on the instance.
    INSERT INTO fsm_core.fsm_instance_queue_event_logs (
        fsm_instance_id, fsm_instance_id_fsm_type, fsm_instance_id_fsm_version,
        event_name, event_data, event_status, execution_finished_at
    ) VALUES (
        input_fsm_instance_id, instance_row.fsm_name, instance_row.fsm_version,
        input_event_name,
        jsonb_build_object(
            'parent_fsm_instance_id', instance_row.parent_fsm_instance_id,
            'parent_invoke_id', instance_row.parent_invoke_id,
            'cancelled_dispatch_count', cancelled_dispatch_count,
            'archived_msg_ids', to_jsonb(archived_msg_ids),
            'stopped_invokes', stopped_invokes
        ),
        'stopped',
        now()
    ) RETURNING fsm_instance_queue_event_log_id INTO event_log_id;

    RETURN jsonb_build_object(
        'status', 'stopped',
        'fsm_instance_id', input_fsm_instance_id,
        'cancelled_dispatch_count', cancelled_dispatch_count,
        'archived_msg_ids', to_jsonb(archived_msg_ids),
        'stopped_invokes', stopped_invokes,
        'event_log_id', event_log_id
    );
END;
$$ LANGUAGE plpgsql;


-- A child machine whose invoking state exited. It never reports to its
-- parent: a stopped actor sends nothing.
CREATE OR REPLACE FUNCTION fsm_core.stop_child_fsm_v2(
    input_child_fsm_instance_id uuid
) RETURNS jsonb AS $$
BEGIN
    RETURN fsm_core.stop_fsm_instance_v2(input_child_fsm_instance_id, 'stop_child');
END;
$$ LANGUAGE plpgsql;


-- Stops one entry of total_async_operation_queue_data (the entry
-- start_invoked_async_operation_v2 returned), by its async_operation_type.
CREATE OR REPLACE FUNCTION fsm_core.stop_invoked_async_operation_v2(
    input_entry jsonb
) RETURNS jsonb AS $$
DECLARE
    -- Entries saved before #526 have no async_operation_type; every one of
    -- them was an actor's queue message, and was cancelled as one.
    entry_type text := COALESCE(input_entry->>'async_operation_type', 'internalAsyncOperation');
BEGIN
    IF entry_type IN ('internalAsyncOperation', 'sharedAsyncOperation') THEN
        -- Its message is cancelled, unless its result was archived first
        -- (#533). An invoke a worker is already running is stopped by the
        -- Activity Gateway, on the notification this sends (SPEC-012).
        RETURN fsm_core.finish_async_operation_event_v2(
            input_archive_reason := 'cancelled',
            input_async_operation_queue_name := input_entry->>'queue_id',
            input_async_operation_queue_msg_id := (input_entry->>'queue_msg_id')::bigint
        );
    ELSIF entry_type = 'fsm' THEN
        RETURN fsm_core.stop_child_fsm_v2((input_entry->>'queue_id')::uuid);
    ELSE
        RAISE EXCEPTION 'stop_invoked_async_operation_v2: unsupported async operation type: %', entry_type;
    END IF;
END;
$$ LANGUAGE plpgsql;


-- A macrostep that must not be applied (#534). The fsmlet has already run
-- XState and computed a transition (new state and context, schedules and
-- invokes to stop and start) before it calls the archive; discarding throws
-- that result away instead of saving it, as if the event had never been
-- processed. The archive returns before its exit side, so nothing is cancelled,
-- stopped, started or saved and no parent is told. Three reasons, checked in
-- this order under the instance's row lock (see the archive's steps 2 and 3):
--   instance_not_active       the row is stopped, done or error: a parent
--                             stopped this child, or the fsmlet woke on the
--                             xstate.stop a stop sends
--   message_already_archived  the pgmq message was archived by someone else:
--                             a second fsmlet got it after its visibility
--                             timeout and saved first, or a stop archived the
--                             queue
--   internal_event_not_head   the internal event is no longer the queue's head:
--                             another fsmlet processed and removed it
--   stale_actor_event         a done/error actor event whose source isn't an
--                             invoke the instance still holds: the result of
--                             an earlier invoke under the same id (#535)
-- The caller has already archived the processed pgmq message (when there is
-- one), so it isn't delivered again. This logs one 'discarded' row and returns
-- what the fsmlet needs: that the macrostep was discarded and why, the
-- instance's status (the fsmlet stops when it isn't active), and its internal
-- event queue. The fsmlet treats a discard as success, not as an error.
-- input_processed_message (#535): the processed pgmq message, when the
-- archive read it (step 3), so the log names the event that was dropped.
DROP FUNCTION IF EXISTS fsm_core.discard_fsm_macrostep_v2(fsm_core.fsm_instance, text, bigint, jsonb);
CREATE OR REPLACE FUNCTION fsm_core.discard_fsm_macrostep_v2(
    input_instance_row fsm_core.fsm_instance,
    input_reason text,
    input_processed_queue_msg_id bigint,
    input_processed_internal_event jsonb,
    input_processed_message jsonb DEFAULT NULL
) RETURNS jsonb AS $$
BEGIN
    INSERT INTO fsm_core.fsm_instance_queue_event_logs (
        fsm_instance_id, fsm_instance_id_fsm_type, fsm_instance_id_fsm_version,
        fsm_instance_queue_msg_id, event_name, event_data, event_source, event_status
    ) VALUES (
        input_instance_row.id, input_instance_row.fsm_type, input_instance_row.fsm_version,
        input_processed_queue_msg_id,
        COALESCE(
            input_processed_internal_event->>'eventType',
            input_processed_message->'eventData'->>'eventType',
            'macrostep'
        ),
        jsonb_build_object(
            'reason', input_reason,
            'processed_internal_event', input_processed_internal_event,
            'source', input_processed_message->'source'
        ),
        CASE WHEN input_processed_internal_event IS NULL THEN 'queue' ELSE 'internal' END,
        'discarded'
    );
    RETURN jsonb_build_object(
        'discarded', true,
        'discarded_reason', input_reason,
        'fsm_instance_status', input_instance_row.fsm_instance_status,
        'internal_event_queue', COALESCE(input_instance_row.internal_event_queue, '[]'::jsonb),
        'internal_event_count', input_instance_row.internal_event_count
    );
END;
$$ LANGUAGE plpgsql;


-- archive_event_from_fsm_type_worker_v2: saves one macrostep. The worker
-- passes the scheduled events and invokes to stop and to start, as items
-- from the compiled actions (each with its id; an invoke also with its src);
-- the entries in the instance's totals are what
-- send_event_to_fsm_queue_with_event_logs_v2 (schedules) and
-- start_invoked_async_operation_v2 (invokes) returned. A parent is read from
-- this instance's row (#523, #526).
--
-- The steps follow SPEC-011's target sequence (#534). Everything is decided
-- under the instance's row lock, before any side effect:
--    1  lock the instance (FOR NO KEY UPDATE)
--    2  status gate: an instance that isn't active takes no macrostep
--    3  consume the processed event, gated: a pgmq message must still be
--       there to archive, an internal event must be the queue's head;
--       otherwise the macrostep is discarded (applied already, or stopped)
--    4  stale done/error actor event: its source must be an invoke the
--       instance still holds (#535); otherwise the macrostep is discarded
--    5  exit side, from the row's totals: cancel schedules, stop invokes
--    6  final status, including the internal-event cycle cap
--    7  entry side, only while active: schedule, start invokes
--    8  terminal status: stop everything still running, archive the queue
--    9  internal event queue
--   10  save the row
--   11  tell the parent, when finished
--   12  return
-- The input totals are only checked against the row: the fsmlet read them
-- without the lock.
--
-- Discarded macrosteps (steps 2 to 4, discard_fsm_macrostep_v2). A macrostep
-- is applied at most once, never to an instance that has stopped or finished,
-- and never for a stale actor result. It is discarded, instead of applied,
-- when the instance isn't active, when its pgmq message was already archived,
-- when its internal event isn't the head of the internal queue, or when it is
-- a done/error actor event from an invoke the instance no longer holds
-- (stale_actor_event, #535). Discarding happens before any
-- side effect; the result says {discarded: true, discarded_reason, ...}. The
-- status gate comes first: a stop clears the internal queue, and its reason is
-- that the instance stopped, not that the event moved. When neither a message
-- id nor an internal event is passed (direct SQL callers), nothing is gated.
-- Each internal event gets an internalEventId when step 9 queues it (#546),
-- so the internal-event check is by identity: two identical events in a row
-- are told apart, as pgmq messages are by msg_id.
--
-- The internal event queue (SPEC-010, #519): raised_events are the done.state
-- events microstep_v2 returned, appended to fsm_instance.internal_event_queue
-- in this transaction (step 9). processed_internal_event is set when the event
-- processed now came from that queue instead of pgmq: it must be the queue's
-- head, which is removed, and no pgmq message is archived (step 3).
-- fsm_instance_data_save_fsm_error is saved as the instance's error, with
-- status error (an unhandled xstate.error.actor.* event, #520); NULL keeps it.
DROP FUNCTION IF EXISTS fsm_core.archive_event_from_fsm_type_worker_v2(
  text, bigint, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, uuid, text, text
);
DROP FUNCTION IF EXISTS fsm_core.archive_event_from_fsm_type_worker_v2(
  text, bigint, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb
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
  fsm_instance_data_save_fsm_xstate_state jsonb,
  raised_events jsonb DEFAULT '[]'::jsonb,
  processed_internal_event jsonb DEFAULT NULL,
  fsm_instance_data_save_fsm_error jsonb DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
    i int;

    instance_row fsm_core.fsm_instance%ROWTYPE;
    current_total_schedule_queue_data jsonb;
    current_total_async_operation_queue_data jsonb;

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
    stop_result jsonb;

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

    terminal_stopped_async_operation_queue_data jsonb := '[]'::jsonb;
    terminal_archived_msg_ids bigint[] := '{}';

    parent_notify_result jsonb;
    child_parent_fsm_name text;
    child_parent_fsm_version text;

    -- SPEC-010's cycle cap: internal events in a row before the instance is
    -- set to error, so a cycle (an onDone that enters another final state that
    -- leads back) can't run forever.
    max_internal_events CONSTANT integer := 100;
    new_internal_event_queue jsonb;
    new_internal_event_count integer;
    saved_status jsonb;
    saved_error jsonb;
    final_status text;
    raised_event jsonb;
    processed_message jsonb;
    processed_event_type text;
    processed_event_source jsonb;
BEGIN
    -- 1. Lock the instance first: every decision below is made on locked
    --    state, serialised with a stop (stop_fsm_instance_v2) and with a
    --    second fsmlet processing the same message.
    SELECT * INTO instance_row
    FROM fsm_core.fsm_instance fi
    WHERE fi.id = remove_from_current_fsm_instance_queue_id::uuid
    FOR NO KEY UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'archive_event_from_fsm_type_worker_v2: fsm instance % not found', remove_from_current_fsm_instance_queue_id;
    END IF;

    -- 2. Status gate. A stopped or finished instance takes no more macrosteps,
    --    as XState drops events sent to an actor that isn't active. Typically a
    --    parent stopped this child (stop_child_fsm_v2) while its fsmlet was
    --    computing a macrostep, or the fsmlet is reading the xstate.stop message
    --    that stop sends to wake it. The processed message is archived, whatever
    --    archive returns (the stop may have archived it already), so it isn't
    --    delivered again; an internal event has nothing to archive. Checked
    --    before the internal-queue head below: a stop clears that queue, and the
    --    reason is that the instance stopped. (A new instance has no status yet:
    --    it is active.)
    IF COALESCE(instance_row.fsm_instance_status #>> '{}', 'active') <> 'active' THEN
        IF remove_current_queue_msg_id IS NOT NULL THEN
            PERFORM pgmq.archive(queue_name := remove_from_current_fsm_instance_queue_id, msg_id := remove_current_queue_msg_id);
        END IF;
        RETURN fsm_core.discard_fsm_macrostep_v2(
            instance_row, 'instance_not_active', remove_current_queue_msg_id, processed_internal_event
        );
    END IF;

    -- 3. Consume the processed event, gated, so each one is applied once. Two
    --    fsmlets can hold the same event: one whose visibility timeout ran out
    --    or that crashed, and the one that took the instance after it. Step 1's
    --    lock makes their saves run one after the other; this decides that only
    --    the first counts.
    IF processed_internal_event IS NOT NULL THEN
        -- An internal event: it must still be the head of the queue, as the
        -- worker took it. Anything else means another fsmlet already processed
        -- and removed it. The worker passes the event back exactly as it read
        -- it, internalEventId included (step 9), so this compares identity:
        -- with two identical events in a row, a late save for the first can't
        -- match the second (#546). An event queued before #546 has no id and
        -- is compared by its contents.
        new_internal_event_queue := COALESCE(instance_row.internal_event_queue, '[]'::jsonb);
        IF new_internal_event_queue->0 IS DISTINCT FROM processed_internal_event THEN
            RETURN fsm_core.discard_fsm_macrostep_v2(
                instance_row, 'internal_event_not_head', NULL, processed_internal_event
            );
        END IF;
        new_internal_event_queue := new_internal_event_queue - 0;
        new_internal_event_count := COALESCE(instance_row.internal_event_count, 0) + 1;
    ELSE
        -- A pgmq message: archiving it is the gate, as pgmq.archive deletes the
        -- message row and only one transaction can. False: it was already
        -- archived, either by another fsmlet that got it after its visibility
        -- timeout and saved first, or by a stop (stop_fsm_instance_v2 archives
        -- the whole queue). No message id (a direct SQL call): not gated.
        -- The message is read first, for step 4: archiving moves it out of
        -- the queue table.
        IF remove_current_queue_msg_id IS NOT NULL THEN
            EXECUTE format('SELECT message FROM pgmq.%I WHERE msg_id = $1', 'q_' || remove_from_current_fsm_instance_queue_id)
            INTO processed_message
            USING remove_current_queue_msg_id;
            IF NOT pgmq.archive(queue_name := remove_from_current_fsm_instance_queue_id, msg_id := remove_current_queue_msg_id) THEN
                RETURN fsm_core.discard_fsm_macrostep_v2(
                    instance_row, 'message_already_archived', remove_current_queue_msg_id, NULL
                );
            END IF;
        END IF;
        new_internal_event_queue := COALESCE(instance_row.internal_event_queue, '[]'::jsonb);
        -- An event from the pgmq queue starts a new count.
        new_internal_event_count := 0;
    END IF;

    -- 4. Stale done/error actor events (SPEC-011 (c), #535). Re-entering a
    --    state starts a new invoke under the same invoke id, and the parent
    --    matches xstate.done.actor.<id> / xstate.error.actor.<id> by name. A
    --    result of the earlier invoke, queued before the parent's exit
    --    committed or after it, would be taken for the new invoke's. So the
    --    event's source (set by finish_async_operation_event_v2 for an actor,
    --    and by step 11 for a child FSM) must still be an invoke this instance
    --    holds: an entry of its totals with the same invoke_id and queue_id
    --    (and queue_msg_id, for an actor). Otherwise the macrostep is
    --    discarded, the same as XState ignoring the event. Checked here, under
    --    the instance's lock, not in the fsmlet: its copy of the totals is
    --    read without the lock. A message without a source (sent before
    --    #533/#535, or by the API) is processed as before.
    processed_event_type := processed_message->'eventData'->>'eventType';
    processed_event_source := processed_message->'source';
    IF processed_event_source IS NOT NULL
        AND (starts_with(processed_event_type, 'xstate.done.actor.')
             OR starts_with(processed_event_type, 'xstate.error.actor.'))
        AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(instance_row.total_async_operation_queue_data, '[]'::jsonb)) held
            WHERE held.value->>'invoke_id' = processed_event_source->>'invoke_id'
              AND held.value->>'queue_id' = processed_event_source->>'queue_id'
              AND (NOT processed_event_source ? 'queue_msg_id'
                   OR (held.value->>'queue_msg_id')::bigint = (processed_event_source->>'queue_msg_id')::bigint)
        )
    THEN
        RETURN fsm_core.discard_fsm_macrostep_v2(
            instance_row, 'stale_actor_event', remove_current_queue_msg_id, NULL, processed_message
        );
    END IF;

    -- 5. The exit side, from the row's totals. The worker's copy was read
    --    without the lock; a difference is only reported.
    current_total_schedule_queue_data := COALESCE(instance_row.total_schedule_queue_data, '[]'::jsonb);
    current_total_async_operation_queue_data := COALESCE(instance_row.total_async_operation_queue_data, '[]'::jsonb);
    IF (input_total_schedule_queue_data IS NOT NULL
            AND input_total_schedule_queue_data IS DISTINCT FROM current_total_schedule_queue_data)
        OR (input_total_async_operation_queue_data IS NOT NULL
            AND input_total_async_operation_queue_data IS DISTINCT FROM current_total_async_operation_queue_data)
    THEN
        RAISE WARNING 'archive_event_from_fsm_type_worker_v2: the worker''s totals for instance % differ from the row; using the row', remove_from_current_fsm_instance_queue_id;
    END IF;

    -- 5a. Remove the cancelled scheduled events from the totals.
    -- A = current_total_schedule_queue_data
    -- B = to_be_removed_schedule_queue_msg_ids
    -- C = confirmed_removed_schedule_queue_data (cancelled)  ( C = A intersect B )
    -- D = not_confirmed_removed_schedule_queue_data (returned) ( D = B - C )
    FOR schedule_queue_entry IN
        SELECT value FROM jsonb_array_elements(current_total_schedule_queue_data) value
    LOOP
        remove_schedule := false;
        -- The scheduled event being processed now has fired: drop its entry
        -- (its message was archived in step 3, #516).
        CONTINUE WHEN (schedule_queue_entry->'queue_data'->>'queueMsgId')::bigint = remove_current_queue_msg_id;
        IF to_be_removed_schedule_queue_msg_ids IS NOT NULL THEN
            FOR i IN 0 .. jsonb_array_length(to_be_removed_schedule_queue_msg_ids)-1 LOOP
                schedule_queue_message := to_be_removed_schedule_queue_msg_ids->i;

                -- A cancel names the scheduled event (`id`, e.g.
                -- xstate.after.1000.<state id>); an entry is what
                -- send_event_to_fsm_queue_with_event_logs_v2 returned when it was
                -- scheduled (#516).
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
            -- jsonb, not a SQL array: append with || (#495).
            new_total_schedule_queue_data := new_total_schedule_queue_data || jsonb_build_array(schedule_queue_entry);
        END IF;
    END LOOP;

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

    -- Archive the cancelled schedules' messages. False: it was no longer
    -- there to cancel.
    FOREACH schedule_queue_entry IN ARRAY confirmed_removed_schedule_queue_data LOOP
        IF pgmq.archive(
            queue_name := remove_from_current_fsm_instance_queue_id,
            msg_id := (schedule_queue_entry->'queue_data'->>'queueMsgId')::bigint
        ) THEN
            confirmed_removed_schedule_queue_data_success := array_append(confirmed_removed_schedule_queue_data_success, schedule_queue_entry);
        ELSE
            confirmed_removed_schedule_queue_data_failed := array_append(confirmed_removed_schedule_queue_data_failed, schedule_queue_entry);
        END IF;
    END LOOP;

    -- 5b. Remove the stopped invokes from the totals, found by invoke_id and
    --     src (an entry from start_invoked_async_operation_v2, #526).
    FOR async_operation_queue_entry IN
        SELECT value FROM jsonb_array_elements(current_total_async_operation_queue_data) value
    LOOP
        remove_async_operation := false;
        IF to_be_removed_async_operation_queue_msg_ids IS NOT NULL THEN
            FOR i IN 0 .. jsonb_array_length(to_be_removed_async_operation_queue_msg_ids)-1 LOOP
                async_operation_queue_message := to_be_removed_async_operation_queue_msg_ids->i;

                IF (
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
            new_total_async_operation_queue_data := new_total_async_operation_queue_data || jsonb_build_array(async_operation_queue_entry);
        END IF;
    END LOOP;

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

    -- Stop them: an actor's queued message is cancelled, a child machine is
    -- stopped with its subtree. Failed: there was nothing left to stop (the
    -- message was already archived, or the child had already finished).
    FOREACH async_operation_queue_entry IN ARRAY confirmed_removed_async_operation_queue_data LOOP
        stop_result := fsm_core.stop_invoked_async_operation_v2(async_operation_queue_entry);
        IF COALESCE((stop_result->>'archive_result')::boolean, false) OR stop_result->>'status' = 'stopped' THEN
            confirmed_removed_async_operation_queue_data_success := array_append(confirmed_removed_async_operation_queue_data_success, async_operation_queue_entry);
        ELSE
            confirmed_removed_async_operation_queue_data_failed := array_append(confirmed_removed_async_operation_queue_data_failed, async_operation_queue_entry);
        END IF;
    END LOOP;

    -- 6. The final status, decided before anything is started: the worker's,
    --    unless the internal-event cycle cap is passed.
    saved_status := fsm_instance_data_save_fsm_status;
    IF new_internal_event_count > max_internal_events THEN
        saved_status := '"error"'::jsonb;
        saved_error := jsonb_build_object(
            'message', format('Infinite loop: more than %s internal events in a row (last: %s)',
                max_internal_events, processed_internal_event->>'eventType')
        );
    END IF;
    final_status := COALESCE(saved_status #>> '{}', 'active');

    -- 7. The entry side, only while active: a finished machine starts nothing.
    IF final_status = 'active' THEN
        -- 7a. Schedule the new delayed events.
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

        -- 7b. Start the invokes of the states entered, as XState's spawnChild
        --     does (#526); each entry is kept until its invoking state exits.
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
    ELSE
        -- 8. Done, error or stopped: as XState stops an actor's children when
        --    it finishes or fails, every invoke still running is stopped, and
        --    every message left on the queue (delayed events included) is
        --    archived; nothing more is processed.
        FOR async_operation_queue_entry IN
            SELECT value FROM jsonb_array_elements(new_total_async_operation_queue_data) value
        LOOP
            terminal_stopped_async_operation_queue_data := terminal_stopped_async_operation_queue_data
                || jsonb_build_array(fsm_core.stop_invoked_async_operation_v2(async_operation_queue_entry));
        END LOOP;
        terminal_archived_msg_ids := fsm_core.archive_fsm_instance_queue_messages_v2(remove_from_current_fsm_instance_queue_id::uuid);
        new_total_async_operation_queue_data := '[]'::jsonb;
        new_total_schedule_queue_data := '[]'::jsonb;
    END IF;

    -- 9. The internal event queue (SPEC-010, #519).
    IF final_status = 'active' THEN
        -- internalQueue.push(...): this microstep's raised events go after the
        -- ones already waiting, each logged as an internal event. Each gets an
        -- internalEventId, its identity for step 3's gate (#546); the fsmlet
        -- doesn't pass it on to XState.
        FOR raised_event IN SELECT value FROM jsonb_array_elements(COALESCE(raised_events, '[]'::jsonb)) value
        LOOP
            raised_event := raised_event || jsonb_build_object('internalEventId', gen_random_uuid());
            new_internal_event_queue := new_internal_event_queue || jsonb_build_array(raised_event);
            INSERT INTO fsm_core.fsm_instance_queue_event_logs (
                fsm_instance_id, fsm_instance_id_fsm_type, fsm_instance_id_fsm_version,
                event_name, event_data, event_delay, event_source, event_status, event_output
            ) VALUES (
                instance_row.id, instance_row.fsm_type, instance_row.fsm_version,
                raised_event->>'eventType', raised_event, 0, 'internal', 'ACTIVE', '{}'::jsonb
            );
        END LOOP;
    ELSE
        -- Like XState's macrostep, which only runs while the snapshot is
        -- active.
        new_internal_event_queue := '[]'::jsonb;
    END IF;

    -- 10. Save the instance: its new totals, status, state, context, XState
    --     snapshot and internal event queue.
    UPDATE fsm_core.fsm_instance
    SET
        total_schedule_queue_data = new_total_schedule_queue_data,
        total_async_operation_queue_data = new_total_async_operation_queue_data,
        internal_event_queue = new_internal_event_queue,
        internal_event_count = new_internal_event_count,
        fsm_instance_error = COALESCE(saved_error, fsm_instance_data_save_fsm_error, fsm_instance_error),
        fsm_instance_status = saved_status,
        fsm_instance_state = fsm_instance_data_save_fsm_state,
        fsm_instance_context = fsm_instance_data_save_fsm_context,
        fsm_instance_xstate_state = fsm_instance_data_save_fsm_xstate_state
    WHERE id = instance_row.id;

    -- 11. If this instance was invoked by a parent FSM and has finished, tell
    --     the parent, as XState does for a child actor (#523):
    --     xstate.done.actor.<invoke id> when done, xstate.error.actor.<invoke
    --     id> on error, nothing when stopped (step 2 returned already). The
    --     payload is what XState puts on those events: the error on error
    --     (event.error), the one step 10 saved as this instance's error,
    --     which the parent saves as its own if no transition takes the event
    --     (#520); on done, the context, as fsm.json has no output yet (#532:
    --     the error event used to carry the context too). The parent row is
    --     only read, never locked: the event-log insert takes FOR KEY SHARE on
    --     it, which doesn't conflict with the parent's own FOR NO KEY UPDATE.
    IF instance_row.parent_fsm_instance_id IS NOT NULL
        AND final_status IN ('done', 'completed', 'final', 'error')
    THEN
        SELECT p.fsm_name, p.fsm_version
        INTO child_parent_fsm_name, child_parent_fsm_version
        FROM fsm_core.fsm_instance p
        WHERE p.id = instance_row.parent_fsm_instance_id;

        parent_notify_result := fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
            input_fsm_instance_id              := instance_row.parent_fsm_instance_id,
            input_fsm_instance_id_fsm_type     := child_parent_fsm_name,
            input_fsm_instance_id_fsm_version  := child_parent_fsm_version,
            input_event_name                   := CASE
                                                      WHEN final_status = 'error'
                                                      THEN 'xstate.error.actor.'
                                                      ELSE 'xstate.done.actor.'
                                                  END || instance_row.parent_invoke_id,
            input_event_action_type            := 'childFsm_completed',
            input_event_data                   := CASE
                                                      WHEN final_status = 'error'
                                                      THEN COALESCE(saved_error, fsm_instance_data_save_fsm_error, instance_row.fsm_instance_error)
                                                      ELSE fsm_instance_data_save_fsm_context
                                                  END,
            input_event_delay                  := 0,
            input_event_status                 := 'ACTIVE',
            input_event_output                 := '{}'::jsonb,
            input_error_message                := CASE
                                                      WHEN final_status = 'error'
                                                      THEN COALESCE(saved_error, fsm_instance_data_save_fsm_error, instance_row.fsm_instance_error)->>'message'
                                                  END,
            -- This child, as the parent's entry for it names it, for the
            -- parent's stale-event check (step 4, #535).
            input_event_source                 := jsonb_build_object(
                                                      'invoke_id', instance_row.parent_invoke_id,
                                                      'queue_id', instance_row.id::text
                                                  )
        );
    END IF;

    -- 12. Return.
    RETURN jsonb_build_object(
         'discarded', false,
         'fsm_instance_status', saved_status,

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

         'old_total_schedule_queue_data', current_total_schedule_queue_data,
         'old_total_async_operation_queue_data', current_total_async_operation_queue_data,

         'terminal_stopped_async_operation_queue_data', terminal_stopped_async_operation_queue_data,
         'terminal_archived_msg_ids', to_jsonb(terminal_archived_msg_ids),

         'internal_event_queue', new_internal_event_queue,
         'internal_event_count', new_internal_event_count,
         'parent_notify_result', parent_notify_result
      );

END;
$$ LANGUAGE plpgsql;
