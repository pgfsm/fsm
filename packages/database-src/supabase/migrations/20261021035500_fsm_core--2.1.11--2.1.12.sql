drop function if exists "fsm_core"."discard_fsm_macrostep_v2"(input_instance_row fsm_core.fsm_instance, input_reason text, input_processed_queue_msg_id bigint, input_processed_internal_event jsonb);

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.discard_fsm_macrostep_v2(input_instance_row fsm_core.fsm_instance, input_reason text, input_processed_queue_msg_id bigint, input_processed_internal_event jsonb, input_processed_message jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.archive_event_from_fsm_type_worker_v2(remove_from_current_fsm_instance_queue_id text, remove_current_queue_msg_id bigint, to_be_removed_schedule_queue_msg_ids jsonb, to_be_removed_async_operation_queue_msg_ids jsonb, to_be_added_schedule_queue_data jsonb, to_be_added_async_operation_queue_data jsonb, input_total_schedule_queue_data jsonb, input_total_async_operation_queue_data jsonb, fsm_instance_data_save_fsm_status jsonb, fsm_instance_data_save_fsm_state jsonb, fsm_instance_data_save_fsm_context jsonb, fsm_instance_data_save_fsm_xstate_state jsonb, raised_events jsonb DEFAULT '[]'::jsonb, processed_internal_event jsonb DEFAULT NULL::jsonb, fsm_instance_data_save_fsm_error jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
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
        -- and removed it. This compares contents, not identity: two identical
        -- events in a row can't be told apart (#546).
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
        -- ones already waiting, each logged as an internal event.
        FOR raised_event IN SELECT value FROM jsonb_array_elements(COALESCE(raised_events, '[]'::jsonb)) value
        LOOP
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
    --     parent row is only read, never locked: the event-log insert takes
    --     FOR KEY SHARE on it, which doesn't conflict with the parent's own
    --     FOR NO KEY UPDATE.
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
            input_event_data                   := fsm_instance_data_save_fsm_context,
            input_event_delay                  := 0,
            input_event_status                 := 'ACTIVE',
            input_event_output                 := '{}'::jsonb,
            input_error_message                := NULL,
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
$function$
;



-- Not captured by `supabase db diff` (see packages/database-src/CLAUDE.md,
-- "Access control"): discard_fsm_macrostep_v2 was dropped and re-created with
-- input_processed_message (#535). It is internal, called only from the
-- SECURITY DEFINER archive.
REVOKE EXECUTE ON FUNCTION fsm_core.discard_fsm_macrostep_v2(fsm_core.fsm_instance, text, bigint, jsonb, jsonb) FROM PUBLIC;
