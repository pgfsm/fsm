-- ============================================================
-- 1. create_async_op_queue_and_send_event_from_fsm_instance_id_v2 (renamed)
--    Routes internalAsyncOperation/sharedAsyncOperation events to the
--    async-operation queue.
--    Checks queue existence, creates if missing, returns send result.
-- ============================================================
DROP FUNCTION IF EXISTS fsm_core.create_async_op_queue_and_send_event_from_fsm_instance_id_v2(text, jsonb, text, text, text, text, text, text, text, text, uuid);
-- Queue naming delegates to fsm_core.compute_async_operation_queue_name_v2
-- (30_async_operation_worker_v2/20260806201803_ensure_async_operation_queue_for_worker.sql,
-- loaded before this file) instead of computing it inline, so this function
-- and fsm-async-worker-gateway-ts's poll loop (claim_pending_async_operation_events_for_workers_v2,
-- same shared helper) can never drift onto different queue names for the
-- same actor identity again. fsmLanguage is a new parameter this call needs
-- to pass through -- the compiled FSM's invoke action params already carry
-- it (see fsm.json), archive_event_from_fsm_type_worker_v2 just wasn't
-- reading it yet.
--
-- compute_async_operation_queue_name_v2 now also validates fsmType itself and raises
-- on anything outside internalAsyncOperation/sharedAsyncOperation (see its
-- own doc comment) -- the check below is redundant against that but kept so
-- this function fails with its own, call-site-specific message rather than
-- relying on the shared helper's.
CREATE OR REPLACE FUNCTION fsm_core.create_async_op_queue_and_send_event_from_fsm_instance_id_v2(
    event_name text,
    event_input jsonb,
    id text,
    action_type text,
    src text,
    asyncOperationName text,
    asyncOperationType text,
    asyncOperationVersion text,
    parentFsmName text,
    parentFsmVersion text,
    asyncOperationLanguage text,
    from_source_fsm_instance_id uuid
) RETURNS jsonb AS $$
DECLARE
    async_operation_queue_name text;
    queue_exists boolean := false;
    start_queue_worker boolean := false;
    send_result jsonb;
BEGIN
    IF asyncOperationType NOT IN ('internalAsyncOperation', 'sharedAsyncOperation') THEN
        RAISE EXCEPTION 'create_async_op_queue_and_send_event_from_fsm_instance_id_v2: unsupported fsmType: %', asyncOperationType;
    END IF;

    async_operation_queue_name := fsm_core.compute_async_operation_queue_name_v2(
        parentFsmName, parentFsmVersion, asyncOperationType, asyncOperationName, asyncOperationVersion, asyncOperationLanguage
    );

    SELECT EXISTS (
        SELECT 1 FROM pgmq.list_queues() WHERE queue_name = async_operation_queue_name
    ) INTO queue_exists;

    IF NOT queue_exists THEN
        PERFORM pgmq.create(queue_name := async_operation_queue_name);
        start_queue_worker := true;
    END IF;

    send_result := fsm_core.send_event_to_async_operation_queue_with_event_logs_v2(
        input_async_operation_queue_name := async_operation_queue_name,
        input_async_operation_fn_name := asyncOperationName,
        input_async_operation_queue_type := asyncOperationType,
        input_async_operation_queue_version := asyncOperationVersion,
        input_send_to_parent_queue_id := from_source_fsm_instance_id,
        input_send_to_parent_queue_type := 'FSM',
        input_send_to_parent_queue_id_event_name := id,
        input_event_name := event_name,
        input_event_action_type := action_type,
        input_event_data := event_input,
        input_event_delay := 0,
        input_event_status := 'async_operation_started',
        input_event_output := '{}'::jsonb,
        input_error_message := NULL
    );

    RETURN send_result || jsonb_build_object('start_queue_worker', start_queue_worker);
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- 2. create_fsm_queue_and_send_event_from_fsm_instance_id_v2 (renamed)
--    Routes childFsm events: generates UUID child queue,
--    creates it, sends event, returns send result.
-- ============================================================
DROP FUNCTION IF EXISTS fsm_core.create_fsm_queue_and_send_event_from_fsm_instance_id_v2(text, jsonb, text, text, text, text, text, text, text, text, uuid);
CREATE OR REPLACE FUNCTION fsm_core.create_fsm_queue_and_send_event_from_fsm_instance_id_v2(
    event_name text,
    event_input jsonb,
    id text,
    action_type text,
    src text,
    fsmName text,
    fsmType text,
    fsmVersion text,
    parentFsmName text,
    parentFsmVersion text,
    from_source_fsm_instance_id uuid
) RETURNS jsonb AS $$
DECLARE
    child_instance_id uuid := uuid_generate_v4();
    send_result jsonb;
BEGIN
    PERFORM pgmq.create(queue_name := child_instance_id::text);

    send_result := fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
        input_fsm_instance_id := child_instance_id,
        input_fsm_instance_id_fsm_type := fsmType,
        input_fsm_instance_id_fsm_version := fsmVersion,
        input_send_to_parent_queue_id := from_source_fsm_instance_id,
        input_send_to_parent_queue_type := 'FSM OR childFSM OR sharedFSM', -- # TODO : pending
        input_send_to_parent_queue_id_event_name := id,
        input_event_name := event_name,
        input_event_action_type := action_type,
        input_event_data := event_input,
        input_event_delay := 0,
        input_event_status := 'fsm_started',
        input_event_output := '{}'::jsonb,
        input_error_message := NULL
    );

    RETURN send_result || jsonb_build_object('start_queue_worker', true, 'child_instance_id', child_instance_id);
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- 3. send_event_to_queue_from_fsm_instance_id_v2
--    Fix: pgmq.create (was fsm_core.create), real queue_exists check,
--         delegate to sub-functions, remove dead RETURN at end
-- ============================================================
DROP FUNCTION IF EXISTS fsm_core.send_event_to_queue_from_fsm_instance_id_v2(text, jsonb, text, text, text, text, text, text, text, text, uuid);
CREATE OR REPLACE FUNCTION fsm_core.send_event_to_queue_from_fsm_instance_id_v2(
    event_name text,
    event_input jsonb,
    id text,
    action_type text,
    src text,
    asyncOperationName text,
    asyncOperationType text,
    asyncOperationVersion text,
    parentFsmName text,
    parentFsmVersion text,
    asyncOperationLanguage text,
    from_source_fsm_instance_id uuid
) RETURNS jsonb AS $$
BEGIN
    IF asyncOperationType = 'internalAsyncOperation' OR asyncOperationType = 'sharedAsyncOperation' THEN
        RETURN fsm_core.create_async_op_queue_and_send_event_from_fsm_instance_id_v2(
            event_name := event_name,
            event_input := event_input,
            id := id,
            action_type := action_type,
            src := src,
            asyncOperationName := asyncOperationName,
            asyncOperationType := asyncOperationType,
            asyncOperationVersion := asyncOperationVersion,
            parentFsmName := parentFsmName,
            parentFsmVersion := parentFsmVersion,
            asyncOperationLanguage := asyncOperationLanguage,
            from_source_fsm_instance_id := from_source_fsm_instance_id
        );
    ELSIF asyncOperationType = 'fsm' THEN
        -- TODO: should we call fsm_core.create_fsm_queue_and_send_event_from_fsm_instance_id_v2 OR call fsm_core.create_fsm_instance_from_name_v2
        RETURN fsm_core.create_fsm_queue_and_send_event_from_fsm_instance_id_v2(
            event_name := event_name,
            event_input := event_input,
            id := id,
            action_type := action_type,
            src := src,
            fsmName := asyncOperationName,
            fsmType := asyncOperationType,
            fsmVersion := asyncOperationVersion,
            parentFsmName := parentFsmName,
            parentFsmVersion := parentFsmVersion,
            from_source_fsm_instance_id := from_source_fsm_instance_id
        );
    ELSE
        RAISE EXCEPTION 'Unsupported fsmType: %', asyncOperationType;
    END IF;
END;
$$ LANGUAGE plpgsql;



-- OLD structure for reference

-- to_be_removed_async_operation_queue_msg_ids example input:
-- [
--   {
--     id: "0.(machine).creditCheck.Verifying Credentials",
--     src: "verifyCredentials",
--     type: "xstate.invoke",
--     fsm_order: 3,
--     action_type: "invoke",
--   },
-- ]

-- input_total_async_operation_queue_data example input:
-- [
--   {
--     event: {
--       type: "async_operation",
--       event_data: null,
--       send_to_parent_queue_id: "5426d9c2-5c3f-49e7-ac1e-9388b659116f",
--       send_event_name_to_parent_queue_id: "0.(machine).creditCheck.Verifying Credentials",
--     },
--     queue_msg_id: 4,
--     async_operation_queue_name: "verifyCredentials",
--     start_async_operation_worker: true,
--   },
-- ]


-- NEW structure for reference
-- to_be_removed_async_operation_queue_msg_ids example input:
-- [
--     {
--       id: "0.(machine).creditCheck.Verifying Credentials",
--       src: "verifyCredentials",
--       type: "xstate.invoke",
--       fsmType: "async_operation",
--       fsm_order: 3,
--       fsmVersion: "v01",
--       action_type: "invoke"
--     }
-- ]

-- input_total_async_operation_queue_data example input:
-- [
--     {
--     queue_id: "creditCheck_v01_verifyCredentials",
--     queue_msg_id: 2,
--     queue_msg_delay: 0,
--     event_data: {
--         event_type: "0.(machine).creditCheck.Verifying Credentials",
--         action_type: "invoke",
--         event_payload: null
--     },
--     queue_type: "async_operation",
--     queue_fn_name: "verifyCredentials",
--     queue_version: "v01",
--     send_to_parent_queue_id: "44ab9fd4-4411-4e1f-aa31-c687d2b925b6",
--     send_to_parent_queue_type: "fsm",
--     send_to_parent_queue_id_event_name: "done.0.(machine).creditCheck.Verifying Credentials"
--     }
-- ]

-- macro save fn
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
  send_to_parent_queue_id uuid,
  send_to_parent_queue_type text,
  send_to_parent_queue_id_event_name text
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
            IF to_be_removed_schedule_queue_msg_ids IS NOT NULL THEN
                FOR i IN 0 .. jsonb_array_length(to_be_removed_schedule_queue_msg_ids)-1 LOOP
                    schedule_queue_message := to_be_removed_schedule_queue_msg_ids->i;

                    IF (
                        (schedule_queue_entry->'event'->>'send_event_name_to_parent_queue_id')::text = (schedule_queue_message->>'id')::text
                        AND (schedule_queue_entry->>'schedule_queue_name')::text = (schedule_queue_message->>'src')::text
                    ) THEN
                        remove_schedule := true;

                        EXIT;
                    END IF;
                END LOOP;
            END IF;

            IF remove_schedule THEN
                confirmed_removed_schedule_queue_data := array_append(confirmed_removed_schedule_queue_data, schedule_queue_entry);
            ELSE
                new_total_schedule_queue_data := array_append(new_total_schedule_queue_data, schedule_queue_entry);
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
                    (schedule_queue_entry->>'id')::text = (schedule_queue_message->>'id')::text
                    AND (schedule_queue_entry->>'src')::text = (schedule_queue_message->>'src')::text
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
                new_total_async_operation_queue_data := array_append(new_total_async_operation_queue_data, async_operation_queue_entry);
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
                PERFORM pgmq.archive(queue_name := remove_from_current_fsm_instance_queue_id, msg_id := (schedule_queue_entry->>'type')::bigint);
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

    -- 9. If FSM reached a terminal state and has a real parent queue, notify the parent
    IF (fsm_instance_data_save_fsm_status #>> '{}') IN ('done', 'stopped', 'completed', 'final')
        AND send_to_parent_queue_id IS NOT NULL
        AND send_to_parent_queue_id != fsm_core.pg_system_queue_uuid()
        AND send_to_parent_queue_id != fsm_core.api_system_queue_uuid()
    THEN
        parent_notify_result := fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
            input_fsm_instance_id              := send_to_parent_queue_id,
            input_fsm_instance_id_fsm_type     := send_to_parent_queue_type,
            input_fsm_instance_id_fsm_version  := NULL,
            input_send_to_parent_queue_id      := fsm_core.pg_system_queue_uuid(),
            input_send_to_parent_queue_type    := fsm_core.pg_system_queue_type(),
            input_send_to_parent_queue_id_event_name := fsm_core.pg_system_event_name(),
            input_event_name                   := send_to_parent_queue_id_event_name,
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

