-- ============================================================
-- finish_async_operation_event_v2 (SPEC-011 (a), #533): the one way an
-- actor's message on its async operation queue is finished, by its worker's
-- result or by a cancel. It replaces the two functions that each did their
-- side effects whatever pgmq.archive returned:
--   archive_event_from_fsm_async_operation_type_worker_v2  (completion)
--     now a deprecated wrapper over this one (below), kept for one release:
--     a gateway deployed before #533 calls it by name, and so do the v1
--     worker and @pgfsm/db's archiveEventFromFsmAsyncOperationTypeWorker
--   cancel_event_for_fsm_async_operation_type_worker_v2    (cancel)
--     dropped (#533): stop_invoked_async_operation_v2 calls this function
--     directly, and nothing else called it
--
-- The gate: pgmq.archive deletes the message row, so a completion and a
-- cancel racing on one message serialise on its row lock and exactly one of
-- them archives it. Only the one that did acts:
--   completed  the result is sent to the parent, if it has a real one, as
--              xstate.done.actor.* / xstate.error.actor.* (input_event_name,
--              prefixed by the gateway), with its source. "completed" means
--              the worker finished, whether it succeeded or failed (including
--              the archive after the last delivery attempt, #396).
--   cancelled  the invoking state exited: pg_notify on
--              fsm_async_operation_cancel with {queue_name, msg_id}, delivered
--              when the transaction commits, so the Activity Gateway can stop
--              a worker that is already running it (SPEC-012).
-- So a cancel that wins means the late result never reaches the parent (it
-- used to, and #510 discarded it there), and a completion that wins means no
-- cancel is announced for a worker that has already finished.
--
-- The source on a completed result (#533) is
--   {invoke_id, queue_id: <this queue>, queue_msg_id}
-- (invoke_id is the parent's invoke id, sent with the message as
-- sendToParentQueueIdEventName). It lets the parent tell the result of the
-- invoke it holds from a stale one of an earlier invoke under the same id
-- (SPEC-011 (c), #535).
--
-- Always one fsm_async_operation_queue_event_logs row: its event_status is
-- the outcome (the worker's status, or 'canceled') when this call archived the
-- message, and 'discarded' when it didn't, with the reason in event_data, so
-- a dropped late result stays visible.
-- ============================================================
CREATE OR REPLACE FUNCTION fsm_core.finish_async_operation_event_v2(
    input_archive_reason text,
    input_async_operation_queue_name text,
    input_async_operation_queue_msg_id bigint,
    -- completion only:
    input_async_operation_queue_type text DEFAULT NULL,
    input_async_operation_queue_version text DEFAULT NULL,
    input_event_name text DEFAULT NULL,
    input_event_action_type text DEFAULT NULL,
    input_event_data jsonb DEFAULT NULL,
    input_event_delay integer DEFAULT 0,
    input_send_to_parent_queue_id uuid DEFAULT NULL,
    input_send_to_parent_queue_id_event_name text DEFAULT NULL,
    input_execution_started_at timestamp with time zone DEFAULT NULL,
    input_execution_duration integer DEFAULT NULL,
    input_execution_finished_at timestamp with time zone DEFAULT now(),
    input_event_status text DEFAULT NULL,
    input_event_output jsonb DEFAULT NULL,
    input_error_message text DEFAULT NULL
)
RETURNS jsonb
AS $$
DECLARE
    archived boolean;
    send_to_parent_result jsonb;
    cancel_notified boolean := false;
    logged_status text;
    logged_event_name text;
    logged_event_data jsonb;
    output_async_operation_queue_event_log_id uuid;
BEGIN
    IF input_archive_reason IS NULL OR input_archive_reason NOT IN ('completed', 'cancelled') THEN
        RAISE EXCEPTION 'finish_async_operation_event_v2: the archive reason must be completed or cancelled, not %', input_archive_reason;
    END IF;

    -- 1. The gate: only the call that archives the message acts on it.
    archived := pgmq.archive(
        queue_name := input_async_operation_queue_name,
        msg_id := input_async_operation_queue_msg_id
    );

    IF input_archive_reason = 'completed' THEN
        logged_event_name := input_event_name;
        IF NOT archived THEN
            -- Cancelled (its state exited), or finished already: nobody
            -- waits for this result.
            send_to_parent_result := jsonb_build_object('skipped', true, 'reason', 'message already archived');
        ELSIF input_send_to_parent_queue_id IS NOT NULL
            AND input_send_to_parent_queue_id <> fsm_core.pg_system_queue_uuid()
            AND input_send_to_parent_queue_id <> fsm_core.api_system_queue_uuid()
        THEN
            -- 2. A real parent: send it the result, with its source. (No
            --    parent, or a system sentinel: there is nobody to tell.)
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
                input_execution_finished_at := input_execution_finished_at,
                input_event_source := jsonb_build_object(
                    'invoke_id', input_send_to_parent_queue_id_event_name,
                    'queue_id', input_async_operation_queue_name,
                    'queue_msg_id', input_async_operation_queue_msg_id
                )
            );
        ELSE
            send_to_parent_result := jsonb_build_object('skipped', true, 'reason', 'no real parent to notify');
        END IF;
        logged_status := CASE WHEN archived THEN input_event_status ELSE 'discarded' END;
        logged_event_data := CASE WHEN archived THEN input_event_data
            ELSE jsonb_build_object('archive_reason', input_archive_reason, 'reason', 'message already archived', 'event_data', input_event_data)
        END;
    ELSE
        logged_event_name := 'cancel';
        IF archived THEN
            -- 2. The invoking state exited while its message was still on the
            --    queue, waiting or being run by a worker: announce it.
            PERFORM pg_notify(
                'fsm_async_operation_cancel',
                jsonb_build_object(
                    'queue_name', input_async_operation_queue_name,
                    'msg_id', input_async_operation_queue_msg_id
                )::text
            );
            cancel_notified := true;
            logged_status := 'canceled';
        ELSE
            -- Its result was archived first: the worker has finished, and
            -- there is nothing to cancel.
            logged_status := 'discarded';
            logged_event_data := jsonb_build_object('archive_reason', input_archive_reason, 'reason', 'message already archived');
        END IF;
    END IF;

    -- 3. Log it.
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
        logged_event_name,
        logged_event_data,
        input_event_delay,
        input_send_to_parent_queue_id,
        input_send_to_parent_queue_id_event_name,
        input_execution_started_at,
        input_execution_duration,
        input_execution_finished_at,
        logged_status,
        input_event_output,
        input_error_message
    ) RETURNING async_operation_queue_event_log_id INTO output_async_operation_queue_event_log_id;

    -- 4. The result. The old functions' keys are kept, so their callers read
    --    the same fields: async_operation_queue_archive_result,
    --    send_to_parent_result (completion), archive_result, queue_msg_id
    --    (cancel).
    RETURN jsonb_build_object(
        'archive_reason', input_archive_reason,
        'archive_result', archived,
        'async_operation_queue_archive_result', archived,
        'status', logged_status,
        'async_operation_queue_name', input_async_operation_queue_name,
        'async_operation_queue_msg_id', input_async_operation_queue_msg_id,
        'queue_msg_id', input_async_operation_queue_msg_id,
        'send_to_parent_result', send_to_parent_result,
        'cancel_notified', cancel_notified,
        'async_operation_queue_event_log_id', output_async_operation_queue_event_log_id
    );
END;
$$ LANGUAGE plpgsql;


-- Deprecated (#533): finish_async_operation_event_v2('completed', ...). Kept
-- for the v1 worker (fsm-async-worker-ts), which calls it by name. Before
-- #533 it sent the result to the parent even when its archive returned false.
CREATE OR REPLACE FUNCTION fsm_core.archive_event_from_fsm_async_operation_type_worker_v2(
    input_async_operation_queue_name text,
    input_async_operation_queue_type text,
    input_async_operation_queue_version text,
    input_async_operation_queue_msg_id bigint,
    input_event_name text,
    input_event_action_type text,
    input_event_data jsonb,
    input_event_delay integer,
    input_send_to_parent_queue_id uuid,
    input_send_to_parent_queue_id_event_name text,
    input_execution_started_at timestamp with time zone,
    input_execution_duration integer,
    input_execution_finished_at timestamp with time zone,
    input_event_status text,
    input_event_output jsonb,
    input_error_message text
)
RETURNS jsonb
AS $$
BEGIN
    RETURN fsm_core.finish_async_operation_event_v2(
        input_archive_reason := 'completed',
        input_async_operation_queue_name := input_async_operation_queue_name,
        input_async_operation_queue_msg_id := input_async_operation_queue_msg_id,
        input_async_operation_queue_type := input_async_operation_queue_type,
        input_async_operation_queue_version := input_async_operation_queue_version,
        input_event_name := input_event_name,
        input_event_action_type := input_event_action_type,
        input_event_data := input_event_data,
        input_event_delay := input_event_delay,
        input_send_to_parent_queue_id := input_send_to_parent_queue_id,
        input_send_to_parent_queue_id_event_name := input_send_to_parent_queue_id_event_name,
        input_execution_started_at := input_execution_started_at,
        input_execution_duration := input_execution_duration,
        input_execution_finished_at := input_execution_finished_at,
        input_event_status := input_event_status,
        input_event_output := input_event_output,
        input_error_message := input_error_message
    );
END;
$$ LANGUAGE plpgsql;
