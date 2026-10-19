set check_function_bodies = off;

-- #523: an instance invoked as a child FSM records its parent and invoke id.
-- `parent` (default: a system id; nothing read or wrote it) becomes
-- parent_fsm_instance_id, NULL for an instance without a parent.
ALTER TABLE fsm_core.fsm_instance RENAME COLUMN parent TO parent_fsm_instance_id;
ALTER TABLE fsm_core.fsm_instance ALTER COLUMN parent_fsm_instance_id DROP DEFAULT;
UPDATE fsm_core.fsm_instance SET parent_fsm_instance_id = NULL
WHERE parent_fsm_instance_id = '00000000-0000-0000-0000-000000000001'::uuid;
ALTER TABLE fsm_core.fsm_instance ADD COLUMN parent_invoke_id text;

COMMENT ON COLUMN fsm_core.fsm_instance.parent_fsm_instance_id IS
  'The fsm_instance that invoked this one as a child FSM; NULL when started by the API, pgfsmctl or the system. When this instance finishes, that parent is sent xstate.done.actor.<parent_invoke_id> (done) or xstate.error.actor.<parent_invoke_id> (error).';
COMMENT ON COLUMN fsm_core.fsm_instance.parent_invoke_id IS
  'The parent''s invoke id for this child (XState''s child actor id), which names the events the parent gets when this instance finishes.';

-- New optional parameters change the signature: drop the old one so there is
-- no second overload, and re-apply its access control (SPEC-009 §1).
DROP FUNCTION IF EXISTS fsm_core.create_fsm_instance_from_name_v2(text, text, jsonb, boolean);

CREATE OR REPLACE FUNCTION fsm_core.create_fsm_instance_from_name_v2(
    input_fsm_name text,
    input_fsm_version TEXT,
    input_fsm_context jsonb,
    create_pgmq_queue boolean DEFAULT true,
    -- A child FSM: the instance that invokes it and that invoke's id (#523).
    -- Without them the instance has no parent (API, pgfsmctl, system).
    input_parent_fsm_instance_id uuid DEFAULT NULL,
    input_parent_invoke_id text DEFAULT NULL
)
RETURNS JSONB
AS $$
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
                    input_send_to_parent_queue_id := fsm_core.pg_system_queue_uuid(),
                    input_send_to_parent_queue_type := fsm_core.pg_system_queue_type(),
                    input_send_to_parent_queue_id_event_name := fsm_core.pg_system_event_name(),
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
$$ LANGUAGE plpgsql;

ALTER FUNCTION fsm_core.create_fsm_instance_from_name_v2(text, text, jsonb, boolean, uuid, text) SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
REVOKE EXECUTE ON FUNCTION fsm_core.create_fsm_instance_from_name_v2(text, text, jsonb, boolean, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fsm_core.create_fsm_instance_from_name_v2(text, text, jsonb, boolean, uuid, text) TO fsm_operator;

CREATE OR REPLACE FUNCTION fsm_core.create_fsm_queue_and_send_event_from_fsm_instance_id_v2(event_name text, event_input jsonb, id text, action_type text, src text, fsmname text, fsmtype text, fsmversion text, parentfsmname text, parentfsmversion text, from_source_fsm_instance_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
-- An invoked machine is a child actor in XState; here it is a real
-- fsm_instance, created like any other (its row, transition rows, dispatch to
-- an fsmlet, queue and initialTransition_event) with this instance recorded as
-- its parent and `id` as its invoke id, so the parent is told when it finishes
-- (archive step 9, #523). Before, only a queue was made: no row (the event log's
-- foreign key failed the parent's archive), no dispatch, and the invoke id was
-- sent as the child's first event.
DECLARE
    create_result jsonb;
    child_instance_id uuid;
BEGIN
    create_result := fsm_core.create_fsm_instance_from_name_v2(
        input_fsm_name := fsmName,
        input_fsm_version := fsmVersion,
        input_fsm_context := COALESCE(event_input, '{}'::jsonb),
        create_pgmq_queue := true,
        input_parent_fsm_instance_id := from_source_fsm_instance_id,
        input_parent_invoke_id := id
    );
    child_instance_id := (create_result->>'fsm_instance_id')::uuid;
    IF NOT COALESCE((create_result->>'queue_created')::boolean, false) THEN
        RAISE EXCEPTION 'child FSM %@% (invoke %) was created without a queue: %',
            fsmName, fsmVersion, id, create_result->>'message';
    END IF;

    -- The same keys as an async actor's entry (queueId, queueMsgId, queueFnName,
    -- sendToParentQueueIdEventName), so when the invoking state exits the
    -- parent's archive finds it in total_async_operation_queue_data and cancels
    -- the child's queued start event. Stopping a child that is already running
    -- is a follow-up (#514).
    RETURN jsonb_build_object(
        'queueId', child_instance_id::text,
        'queueMsgId', create_result->'send_event_result'->'queue_data'->'queueMsgId',
        'queueFnName', src,
        'sendToParentQueueIdEventName', id,
        'child_instance_id', child_instance_id,
        'start_queue_worker', true
    );
END;
$function$;

CREATE OR REPLACE FUNCTION fsm_core.archive_event_from_fsm_type_worker_v2(remove_from_current_fsm_instance_queue_id text, remove_current_queue_msg_id bigint, to_be_removed_schedule_queue_msg_ids jsonb, to_be_removed_async_operation_queue_msg_ids jsonb, to_be_added_schedule_queue_data jsonb, to_be_added_async_operation_queue_data jsonb, input_total_schedule_queue_data jsonb, input_total_async_operation_queue_data jsonb, fsm_instance_data_save_fsm_status jsonb, fsm_instance_data_save_fsm_state jsonb, fsm_instance_data_save_fsm_context jsonb, fsm_instance_data_save_fsm_xstate_state jsonb, send_to_parent_queue_id uuid, send_to_parent_queue_type text, send_to_parent_queue_id_event_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
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


    -- 1.  Remove schedule queue messages
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


    -- 2. Cancel events for async-operation type workers and remove from input_total_async_operation_queue_data
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
                        (async_operation_queue_entry->>'sendToParentQueueIdEventName')::text = (async_operation_queue_message->>'id')::text
                        AND (async_operation_queue_entry->>'queueFnName')::text = (async_operation_queue_message->>'src')::text
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
                    (async_operation_queue_entry->>'sendToParentQueueIdEventName')::text = (async_operation_queue_message->>'id')::text
                    AND (async_operation_queue_entry->>'queueFnName')::text = (async_operation_queue_message->>'src')::text
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



            -- IF remove_from_current_fsm_instance_queue_id IS NOT NULL AND remove_from_current_fsm_instance_queue_id <> '' AND schedule_queue_message->>'type' IS NOT NULL AND schedule_queue_message->>'type' <> '' THEN
                -- The scheduled message's id, as stored when it was sent (#516).
                PERFORM pgmq.archive(queue_name := remove_from_current_fsm_instance_queue_id, msg_id := (schedule_queue_entry->'queue_data'->>'queueMsgId')::bigint);
                confirmed_removed_schedule_queue_data_success := array_append(confirmed_removed_schedule_queue_data_success, schedule_queue_entry);
            -- END IF;
        END LOOP;
    END IF;

    -- 4. Cancel events for async-operation type workers.
    IF confirmed_removed_async_operation_queue_data IS NOT NULL THEN
        FOR i IN 1 .. COALESCE(array_length(confirmed_removed_async_operation_queue_data, 1), 0) LOOP
            async_operation_queue_entry := confirmed_removed_async_operation_queue_data[i];
            -- pq_name := async_operation_queue_entry->>'async_operation_queue_name';
            -- pq_msg_id := NULL;
            -- BEGIN
                -- pq_msg_id := (async_operation_queue_entry->>'queue_msg_id')::bigint;
            -- EXCEPTION WHEN invalid_text_representation THEN
            --     pq_msg_id := NULL;
            -- END;
            -- IF pq_name IS NOT NULL AND pq_name <> '' AND pq_msg_id IS NOT NULL THEN
                PERFORM fsm_core.cancel_event_for_fsm_async_operation_type_worker_v2(
                    async_operation_type_worker_name := (async_operation_queue_entry->>'queueId')::text,
                    queue_msg_id := (async_operation_queue_entry->>'queueMsgId')::bigint
                );
                confirmed_removed_async_operation_queue_data_success := array_append(confirmed_removed_async_operation_queue_data_success, async_operation_queue_entry);
            -- END IF;
        END LOOP;
    END IF;

    -- 5. Send new schedule events and collect results
    IF to_be_added_schedule_queue_data IS NOT NULL THEN
        FOR i IN 0 .. jsonb_array_length(to_be_added_schedule_queue_data)-1 LOOP
            to_be_added_schedule_queue_data_entry := to_be_added_schedule_queue_data->i;
            to_be_added_schedule_queue_data_entry_delay := COALESCE((to_be_added_schedule_queue_data_entry->>'delay')::integer, 0) / 1000;
            output_schedule_result := fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
                input_fsm_instance_id := remove_from_current_fsm_instance_queue_id::uuid,
                input_fsm_instance_id_fsm_type := to_be_added_schedule_queue_data_entry->>'fsmType',
                input_fsm_instance_id_fsm_version := to_be_added_schedule_queue_data_entry->>'fsmVersion',
                input_send_to_parent_queue_id := remove_from_current_fsm_instance_queue_id::uuid,
                input_send_to_parent_queue_type := 'FSM OR childFSM OR sharedFSM', -- # TODO : pending
                input_send_to_parent_queue_id_event_name := to_be_added_schedule_queue_data_entry->>'id',
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

    -- 6. Send new async-operation events and collect results
    IF to_be_added_async_operation_queue_data IS NOT NULL THEN
        FOR i IN 0 .. jsonb_array_length(to_be_added_async_operation_queue_data)-1 LOOP
            to_be_added_async_operation_queue_data_entry := to_be_added_async_operation_queue_data->i;
            -- IF (to_be_added_async_operation_queue_data_entry->>'src') IS NOT NULL AND (to_be_added_async_operation_queue_data_entry->>'src') <> '' THEN
                -- output_async_operation_result := fsm_core.send_event_to_fsm_async_operation_queue_from_fsm_instance_id_v2(
                --     to_be_added_async_operation_queue_data_entry->>'id', -- type can be also used here
                --     to_be_added_async_operation_queue_data_entry->'input',
                --     to_be_added_async_operation_queue_data_entry->>'src',
                --     remove_from_current_fsm_instance_queue_id::uuid
                --     -- CASE WHEN remove_from_current_fsm_instance_queue_id IS NOT NULL AND remove_from_current_fsm_instance_queue_id <> '' THEN remove_from_current_fsm_instance_queue_id::uuid ELSE NULL::uuid END
                -- );

                output_async_operation_result := fsm_core.send_event_to_queue_from_fsm_instance_id_v2(
                    event_name := to_be_added_async_operation_queue_data_entry->>'id',
                    event_input := to_be_added_async_operation_queue_data_entry->'input',
                    id := to_be_added_async_operation_queue_data_entry->>'id',
                    action_type := to_be_added_async_operation_queue_data_entry->>'action_type',
                    src := to_be_added_async_operation_queue_data_entry->>'src',
                    asyncOperationName := to_be_added_async_operation_queue_data_entry->>'src',
                    asyncOperationType := to_be_added_async_operation_queue_data_entry->>'asyncOperationType',
                    asyncOperationVersion := to_be_added_async_operation_queue_data_entry->>'asyncOperationVersion',
                    parentFsmName := to_be_added_async_operation_queue_data_entry->>'parentFsmName',
                    parentFsmVersion := to_be_added_async_operation_queue_data_entry->>'parentFsmVersion',
                    asyncOperationLanguage := to_be_added_async_operation_queue_data_entry->>'asyncOperationLanguage',
                    from_source_fsm_instance_id := remove_from_current_fsm_instance_queue_id::uuid
                    -- CASE WHEN remove_from_current_fsm_instance_queue_id IS NOT NULL AND remove_from_current_fsm_instance_queue_id <> '' THEN remove_from_current_fsm_instance_queue_id::uuid ELSE NULL::uuid END
                );
            -- ELSE
            --     output_async_operation_result := NULL;
            -- END IF;
            added_async_operation_queue_data := array_append(added_async_operation_queue_data, output_async_operation_result->'queue_data');
            new_total_async_operation_queue_data := new_total_async_operation_queue_data ||  (output_async_operation_result->'queue_data');
        END LOOP;
    END IF;

    -- 7. Update fsm_instance (pseudo-code, adjust as needed)
    UPDATE fsm_core.fsm_instance
    SET
        total_schedule_queue_data = new_total_schedule_queue_data,
        total_async_operation_queue_data = new_total_async_operation_queue_data,
        fsm_instance_status = fsm_instance_data_save_fsm_status,
        fsm_instance_state = fsm_instance_data_save_fsm_state,
        fsm_instance_context = fsm_instance_data_save_fsm_context,
        fsm_instance_xstate_state = fsm_instance_data_save_fsm_xstate_state
    WHERE id = remove_from_current_fsm_instance_queue_id::uuid;

    -- 8. All above macro steps are completed so remove current queue_msg_id from current_workflow_queue_id
    PERFORM pgmq.archive(queue_name := remove_from_current_fsm_instance_queue_id, msg_id := remove_current_queue_msg_id::bigint);

    -- 9. If this instance was invoked by a parent FSM and has finished, tell the
    --    parent, as XState does for a child actor (#523):
    --    xstate.done.actor.<invoke id> when done, xstate.error.actor.<invoke id>
    --    on error, nothing when stopped. The parent comes from this instance's row
    --    (set when it was invoked): the message processed now is usually not the
    --    one that named the parent, so the message's send_to_parent_* is not used.
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
            input_send_to_parent_queue_id      := fsm_core.pg_system_queue_uuid(),
            input_send_to_parent_queue_type    := fsm_core.pg_system_queue_type(),
            input_send_to_parent_queue_id_event_name := fsm_core.pg_system_event_name(),
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
$function$;
