drop function if exists "fsm_core"."cancel_event_for_fsm_async_operation_type_worker_v2"(async_operation_type_worker_name text, queue_msg_id bigint);

drop function if exists "fsm_core"."send_event_to_fsm_queue_with_event_logs_v2"(input_fsm_instance_id uuid, input_fsm_instance_id_fsm_type text, input_fsm_instance_id_fsm_version text, input_event_name text, input_event_action_type text, input_event_data jsonb, input_event_delay integer, input_event_status text, input_event_output jsonb, input_error_message text, input_execution_started_at timestamp with time zone, input_execution_duration integer, input_execution_finished_at timestamp with time zone);

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.finish_async_operation_event_v2(input_archive_reason text, input_async_operation_queue_name text, input_async_operation_queue_msg_id bigint, input_async_operation_queue_type text DEFAULT NULL::text, input_async_operation_queue_version text DEFAULT NULL::text, input_event_name text DEFAULT NULL::text, input_event_action_type text DEFAULT NULL::text, input_event_data jsonb DEFAULT NULL::jsonb, input_event_delay integer DEFAULT 0, input_send_to_parent_queue_id uuid DEFAULT NULL::uuid, input_send_to_parent_queue_id_event_name text DEFAULT NULL::text, input_execution_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone, input_execution_duration integer DEFAULT NULL::integer, input_execution_finished_at timestamp with time zone DEFAULT now(), input_event_status text DEFAULT NULL::text, input_event_output jsonb DEFAULT NULL::jsonb, input_error_message text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.send_event_to_fsm_queue_with_event_logs_v2(input_fsm_instance_id uuid, input_fsm_instance_id_fsm_type text, input_fsm_instance_id_fsm_version text, input_event_name text, input_event_action_type text, input_event_data jsonb, input_event_delay integer DEFAULT 0, input_event_status text DEFAULT 'ACTIVE'::text, input_event_output jsonb DEFAULT '{}'::jsonb, input_error_message text DEFAULT NULL::text, input_execution_started_at timestamp with time zone DEFAULT now(), input_execution_duration integer DEFAULT NULL::integer, input_execution_finished_at timestamp with time zone DEFAULT now(), input_event_source jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
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

    IF input_event_source IS NOT NULL THEN
        queue_msg_data := queue_msg_data || jsonb_build_object('source', input_event_source);
    END IF;

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
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.archive_event_from_fsm_async_operation_type_worker_v2(input_async_operation_queue_name text, input_async_operation_queue_type text, input_async_operation_queue_version text, input_async_operation_queue_msg_id bigint, input_event_name text, input_event_action_type text, input_event_data jsonb, input_event_delay integer, input_send_to_parent_queue_id uuid, input_send_to_parent_queue_id_event_name text, input_execution_started_at timestamp with time zone, input_execution_duration integer, input_execution_finished_at timestamp with time zone, input_event_status text, input_event_output jsonb, input_error_message text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.stop_invoked_async_operation_v2(input_entry jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
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
$function$
;



-- Not captured by `supabase db diff` (see packages/database-src/CLAUDE.md,
-- "Access control"). send_event_to_fsm_queue_with_event_logs_v2 was dropped
-- and re-created with input_event_source (#533), which loses its grants; the
-- gateway calls finish_async_operation_event_v2 as fsm_worker.
REVOKE EXECUTE ON FUNCTION fsm_core.send_event_to_fsm_queue_with_event_logs_v2(uuid, text, text, text, text, jsonb, integer, text, jsonb, text, timestamp with time zone, integer, timestamp with time zone, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fsm_core.send_event_to_fsm_queue_with_event_logs_v2(uuid, text, text, text, text, jsonb, integer, text, jsonb, text, timestamp with time zone, integer, timestamp with time zone, jsonb) TO fsm_operator;
REVOKE EXECUTE ON FUNCTION fsm_core.finish_async_operation_event_v2(text, text, bigint, text, text, text, text, jsonb, integer, uuid, text, timestamp with time zone, integer, timestamp with time zone, text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fsm_core.finish_async_operation_event_v2(text, text, bigint, text, text, text, text, jsonb, integer, uuid, text, timestamp with time zone, integer, timestamp with time zone, text, jsonb, text) TO fsm_worker;
