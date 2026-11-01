-- ── Hand-written (#642): not captured by `supabase db diff` ─────────────────
-- fsm_sim (SPEC-015 §2) comes from
-- supabase/schemas/40_access_control/20261005120100_fsm_core_access_control.sql.
-- The clock seams are moved up from the diffed body below: the diff emits the
-- column defaults that call them before the functions themselves.

-- ── Roles (cluster-wide; idempotent) ────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fsm_sim') THEN
    CREATE ROLE fsm_sim NOLOGIN;
  END IF;
END;
$$;

-- ── Clock seams (supabase/schemas/10_ext_helper/20261031120000_fsm_core_clock.sql)
CREATE OR REPLACE FUNCTION fsm_core.tx_now()
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE
AS $function$
  select case
    when nullif(current_setting('fsm_core.sim_now', true), '') is null then now()
    when pg_has_role(session_user, 'fsm_sim', 'MEMBER')
      then current_setting('fsm_core.sim_now', true)::timestamptz
    else now()
  end;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.wall_now()
 RETURNS timestamp with time zone
 LANGUAGE sql
AS $function$
  select case
    when nullif(current_setting('fsm_core.sim_now', true), '') is null then clock_timestamp()
    when pg_has_role(session_user, 'fsm_sim', 'MEMBER')
      then current_setting('fsm_core.sim_now', true)::timestamptz
    else clock_timestamp()
  end;
$function$
;

-- ── Diffed by `supabase db diff` ────────────────────────────────────────────
alter table "fsm_core"."api_keys" alter column "created_at" set default fsm_core.tx_now();

alter table "fsm_core"."async_operation_instance_and_async_operation_workerlet" alter column "created_at" set default fsm_core.tx_now();

alter table "fsm_core"."async_operation_meta" alter column "updated_at" set default fsm_core.tx_now();

alter table "fsm_core"."async_operation_workerlet" alter column "last_heartbeat" set default fsm_core.tx_now();

alter table "fsm_core"."async_operation_workerlet" alter column "registered_at" set default fsm_core.tx_now();

alter table "fsm_core"."fsm_async_operation_queue_event_logs" alter column "execution_finished_at" set default fsm_core.tx_now();

alter table "fsm_core"."fsm_async_operation_queue_event_logs" alter column "execution_started_at" set default fsm_core.tx_now();

alter table "fsm_core"."fsm_instance" alter column "started_at" set default fsm_core.tx_now();

alter table "fsm_core"."fsm_instance_and_fsm_workerlet" alter column "created_at" set default fsm_core.tx_now();

alter table "fsm_core"."fsm_instance_lock" alter column "locked_at" set default fsm_core.tx_now();

alter table "fsm_core"."fsm_instance_queue_event_logs" alter column "execution_finished_at" set default fsm_core.tx_now();

alter table "fsm_core"."fsm_instance_queue_event_logs" alter column "execution_started_at" set default fsm_core.tx_now();

alter table "fsm_core"."fsm_workerlet" alter column "last_heartbeat" set default fsm_core.tx_now();

alter table "fsm_core"."fsm_workerlet" alter column "registered_at" set default fsm_core.tx_now();

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.async_operation_schedule_next_pending(input_stale_threshold_seconds integer DEFAULT 30)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_entry_id                  uuid;
  v_instance_id               uuid;
  v_async_operation_name      text;
  v_async_operation_version   text;
  v_parent_fsm_name           text;
  v_parent_fsm_version        text;
  v_chosen_workerlet_id       uuid;
BEGIN
  -- Step 1: claim the oldest pending entry (SKIP LOCKED = safe for parallel schedulers).
  SELECT
    async_operation_instance_and_async_operation_workerlet_id,
    async_operation_instance_id,
    async_operation_name,
    async_operation_version,
    parent_fsm_name,
    parent_fsm_version
  INTO
    v_entry_id,
    v_instance_id,
    v_async_operation_name,
    v_async_operation_version,
    v_parent_fsm_name,
    v_parent_fsm_version
  FROM fsm_core.async_operation_instance_and_async_operation_workerlet
  WHERE status = 'pending'
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_entry_id IS NULL THEN
    RETURN false;
  END IF;

  -- Step 2: pick the best available workerlet.
  --   Filter: heartbeat within threshold (node is alive)
  --           AND supported_async_operations contains this operation
  --           AND active_pid_number < max_pid_number (has a free slot)
  --   Score:  most available slots first (max_pid_number - active_pid_number DESC)
  SELECT async_operation_workerlet_id
  INTO v_chosen_workerlet_id
  FROM fsm_core.async_operation_workerlet
  WHERE
    last_heartbeat > fsm_core.tx_now() - (input_stale_threshold_seconds || ' seconds')::interval
    AND active_pid_number < max_pid_number
    AND supported_async_operations @> jsonb_build_array(
          jsonb_build_object(
            'async_operation_name',    v_async_operation_name,
            'async_operation_version', v_async_operation_version,
            'parent_fsm_name',         v_parent_fsm_name,
            'parent_fsm_version',      v_parent_fsm_version
          )
        )
  ORDER BY (max_pid_number - active_pid_number) DESC
  LIMIT 1;

  IF v_chosen_workerlet_id IS NULL THEN
    -- No capable workerlet right now — leave status=pending, retry on next cycle.
    RETURN false;
  END IF;

  -- Step 3: assign the entry to the chosen workerlet.
  UPDATE fsm_core.async_operation_instance_and_async_operation_workerlet
  SET
    status                       = 'scheduled',
    async_operation_workerlet_id = v_chosen_workerlet_id,
    scheduled_at                 = fsm_core.tx_now()
  WHERE async_operation_instance_and_async_operation_workerlet_id = v_entry_id;

  -- Step 4: wake the workerlet via pg_notify.
  -- Prefix must keep prefix + uuid within PostgreSQL's 63-byte channel-name
  -- limit (pg_notify errors above it). Must match
  -- asyncOperationWorkerletNotifyChannel in fsm-core-db-ts.
  PERFORM pg_notify(
    'async_op_workerlet_work_' || v_chosen_workerlet_id::text,
    v_instance_id::text
  );

  RETURN true;
END;
$function$
;

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
    declared_context jsonb;
    instance_context jsonb;
BEGIN
    -- 1. Check if fsm_name and fsm_version exist in fsm_core.fsm_json, and
    --    read the definition's static context (SPEC-013, #584).
    SELECT true, fj.fsm_json->'context'
    INTO fsm_json_exists, declared_context
    FROM fsm_core.fsm_json fj
    WHERE fj.fsm_name = input_fsm_name AND fj.fsm_version = input_fsm_version;

    IF NOT COALESCE(fsm_json_exists, false) THEN
        RAISE EXCEPTION 'FSM with name % and version % not found in fsm_core.fsm_json', input_fsm_name, input_fsm_version;
    END IF;

    -- 1.0. The instance's context (SPEC-013): the definition's static context,
    --      when fsm.json has one, shallow-merged with the context it's created
    --      with, which wins (the API payload, or an invoked child FSM's
    --      input). Without a declared context the given one is used as before.
    --      A non-object given context can't be merged: it's dropped with a
    --      warning, and the instance starts from the declared context alone.
    IF jsonb_typeof(declared_context) IS DISTINCT FROM 'object' THEN
        declared_context := NULL;
    END IF;
    IF input_fsm_context IS NULL OR jsonb_typeof(input_fsm_context) = 'null' THEN
        instance_context := COALESCE(declared_context, input_fsm_context);
    ELSIF jsonb_typeof(input_fsm_context) = 'object' THEN
        instance_context := COALESCE(declared_context, '{}'::jsonb) || input_fsm_context;
    ELSE
        RAISE WARNING 'FSM %@%: ignoring a non-object initial context (%); starting from its declared context',
            input_fsm_name, input_fsm_version, jsonb_typeof(input_fsm_context);
        instance_context := COALESCE(declared_context, '{}'::jsonb);
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
    VALUES (input_fsm_name, input_fsm_version, derived_fsm_type, instance_context, input_parent_fsm_instance_id, input_parent_invoke_id)
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
                    input_execution_started_at := fsm_core.tx_now(),
                    input_execution_duration := NULL,
                    input_execution_finished_at := fsm_core.tx_now()
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
        'fsm_instance_context', instance_context,
        'send_event_result', send_event_result,
        'message', output_message,
        'extra_message', output_extra_message
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.load_async_operation_meta_v2(input_async_operation_name text, input_async_operation_version text, input_async_operation_type text, input_async_operation_language text, input_parent_fsm_name text, input_parent_fsm_version text, input_updated_by_pid text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  INSERT INTO fsm_core.async_operation_meta (
    async_operation_name,
    async_operation_version,
    async_operation_type,
    async_operation_language,
    parent_fsm_name,
    parent_fsm_version,
    updated_by_pid
  ) VALUES (
    input_async_operation_name,
    input_async_operation_version,
    input_async_operation_type,
    input_async_operation_language,
    input_parent_fsm_name,
    input_parent_fsm_version,
    input_updated_by_pid
  )
  ON CONFLICT ON CONSTRAINT async_operation_meta_unique
  DO UPDATE SET
    updated_at             = fsm_core.tx_now(),
    updated_by_pid         = input_updated_by_pid
  RETURNING jsonb_build_object(
    'async_operation_meta_id',async_operation_meta_id,
    'async_operation_name',   async_operation_name,
    'async_operation_version', async_operation_version,
    'async_operation_type',   async_operation_type,
    'async_operation_language', async_operation_language,
    'parent_fsm_name',        parent_fsm_name,
    'parent_fsm_version',     parent_fsm_version,
    'updated_at',             updated_at,
    'updated_by_pid',         updated_by_pid
  ) INTO v_result;

  RETURN v_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.lock_fsm_instance(input_fsm_instance_id uuid, input_locked_by text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    updated_count INTEGER;
BEGIN
    UPDATE fsm_core.fsm_instance
    SET
        worker_locked          = TRUE,
        worker_locked_by       = input_locked_by,
        worker_locked_at       = fsm_core.tx_now(),
        worker_lock_expires_at = NULL
    WHERE id = input_fsm_instance_id
      AND (worker_locked = FALSE OR worker_locked IS NULL);

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count > 0;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.log_async_operation_cancel_ack_v2(input_async_operation_queue_name text, input_async_operation_queue_msg_id bigint, input_invoke_id text, input_reason text, input_outcome text, input_cancel_to_ack_ms integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    output_async_operation_queue_event_log_id uuid;
BEGIN
    IF input_outcome IS NULL OR input_outcome NOT IN ('aborted', 'completed', 'failed') THEN
        RAISE EXCEPTION 'log_async_operation_cancel_ack_v2: the outcome must be aborted, completed or failed, not %', input_outcome;
    END IF;

    INSERT INTO fsm_core.fsm_async_operation_queue_event_logs (
        async_operation_queue_name,
        async_operation_queue_msg_id,
        event_name,
        event_data,
        event_status,
        execution_finished_at
    ) VALUES (
        input_async_operation_queue_name,
        input_async_operation_queue_msg_id,
        'cancel_ack',
        jsonb_build_object(
            'invoke_id', input_invoke_id,
            'reason', input_reason,
            'outcome', input_outcome,
            'cancel_to_ack_ms', input_cancel_to_ack_ms
        ),
        'cancel_acknowledged',
        fsm_core.tx_now()
    ) RETURNING async_operation_queue_event_log_id INTO output_async_operation_queue_event_log_id;

    RETURN output_async_operation_queue_event_log_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.revoke_api_key(input_id_or_name text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pg_temp'
AS $function$
DECLARE
  v_count int;
BEGIN
  UPDATE fsm_core.api_keys
  SET revoked_at = fsm_core.tx_now()
  WHERE revoked_at IS NULL
    AND (id::text = input_id_or_name OR name = input_id_or_name);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.schedule_next_pending(input_stale_threshold_seconds integer DEFAULT 30)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_entry_id          uuid;
  v_instance_id       uuid;
  v_fsm_name          text;
  v_fsm_version       text;
  v_chosen_fsmlet_id  uuid;
BEGIN
  -- Step 1: claim the oldest pending entry (SKIP LOCKED = safe for parallel schedulers).
  SELECT fsm_instance_and_fsm_workerlet_id, fsm_instance_id, fsm_name, fsm_version
  INTO v_entry_id, v_instance_id, v_fsm_name, v_fsm_version
  FROM fsm_core.fsm_instance_and_fsm_workerlet
  WHERE status = 'pending'
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_entry_id IS NULL THEN
    RETURN false;
  END IF;

  -- Step 2: pick the best available fsmlet.
  --   Filter: heartbeat within threshold (node is alive)
  --           AND fsm_modules contains this fsm_name+version
  --           AND active_workers < max_concurrency (has a free slot)
  --   Score:  most available slots first (max_concurrency - active_workers DESC)
  SELECT fsm_workerlet_id
  INTO v_chosen_fsmlet_id
  FROM fsm_core.fsm_workerlet
  WHERE
    last_heartbeat > fsm_core.tx_now() - (input_stale_threshold_seconds || ' seconds')::interval
    AND active_workers < max_concurrency
    AND fsm_modules @> jsonb_build_array(
          jsonb_build_object('fsm_name', v_fsm_name, 'fsm_version', v_fsm_version)
        )
  ORDER BY (max_concurrency - active_workers) DESC
  LIMIT 1;

  IF v_chosen_fsmlet_id IS NULL THEN
    -- No capable fsmlet right now — leave status=pending, retry on next cycle.
    RETURN false;
  END IF;

  -- Step 3: assign the entry to the chosen fsmlet.
  UPDATE fsm_core.fsm_instance_and_fsm_workerlet
  SET
    status              = 'scheduled',
    fsm_workerlet_id = v_chosen_fsmlet_id,
    scheduled_at        = fsm_core.tx_now()
  WHERE fsm_instance_and_fsm_workerlet_id = v_entry_id;

  -- Step 4: wake the fsmlet via pg_notify.
  PERFORM pg_notify('fsm_fsmlet_work_' || v_chosen_fsmlet_id::text, v_instance_id::text);

  RETURN true;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.stop_event_for_fsm_worker_v1(input_fsm_instance_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    instance_row  fsm_core.fsm_instance%ROWTYPE;
    unlock_result boolean;
    event_log_id  uuid;
BEGIN
    -- 1. Fetch instance row (carries worker lock columns)
    SELECT * INTO instance_row
    FROM fsm_core.fsm_instance
    WHERE id = input_fsm_instance_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'status',          'fsm_not_found',
            'fsm_instance_id', input_fsm_instance_id,
            'lock_record',     'null'::jsonb
        );
    END IF;

    -- 2. Worker is not running
    IF instance_row.worker_locked IS NOT TRUE THEN
        RETURN jsonb_build_object(
            'status',          'stopped_or_not_started',
            'fsm_instance_id', input_fsm_instance_id,
            'lock_record',     jsonb_build_object(
                'worker_locked',          instance_row.worker_locked,
                'worker_locked_by',       instance_row.worker_locked_by,
                'worker_locked_at',       instance_row.worker_locked_at,
                'worker_lock_expires_at', instance_row.worker_lock_expires_at
            )
        );
    END IF;

    -- 3. Unlock directly (avoids extra function-call round-trip)
    UPDATE fsm_core.fsm_instance
    SET
        worker_locked          = false,
        worker_locked_by       = NULL,
        worker_locked_at       = NULL,
        worker_lock_expires_at = NULL
    WHERE id = input_fsm_instance_id;
    unlock_result := FOUND;

    -- 4. pg_notify so the LISTEN connection wakes any live worker
    PERFORM pg_notify('fsm_worker_stop', input_fsm_instance_id::text);

    -- 5. Log to fsm_instance_queue_event_logs
    INSERT INTO fsm_core.fsm_instance_queue_event_logs (
        fsm_instance_id,
        event_name,
        event_status,
        event_data,
        execution_finished_at
    ) VALUES (
        input_fsm_instance_id,
        'stop_worker',
        'stopped',
        jsonb_build_object('triggered_by', 'stop_event_for_fsm_worker_v1'),
        fsm_core.tx_now()
    ) RETURNING fsm_instance_queue_event_log_id INTO event_log_id;

    -- 6. Return
    RETURN jsonb_build_object(
        'status',          'stopped',
        'fsm_instance_id', input_fsm_instance_id,
        'unlock_result',   unlock_result,
        'event_log_id',    event_log_id,
        'lock_record',     jsonb_build_object(
            'worker_locked',          instance_row.worker_locked,
            'worker_locked_by',       instance_row.worker_locked_by,
            'worker_locked_at',       instance_row.worker_locked_at,
            'worker_lock_expires_at', instance_row.worker_lock_expires_at
        )
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.stop_event_for_fsm_worker_v2(input_fsm_instance_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    instance_row    fsm_core.fsm_instance%ROWTYPE;
    cancelled_count int;
    event_log_id    uuid;
BEGIN
    -- 1. Fetch instance row
    SELECT * INTO instance_row
    FROM fsm_core.fsm_instance
    WHERE id = input_fsm_instance_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'status',          'fsm_not_found',
            'fsm_instance_id', input_fsm_instance_id
        );
    END IF;

    -- 2. Guard: nothing to cancel if instance is in a terminal state
    --    (fsm_instance_status can be inspected here if needed in the future)

    -- 3. Cancel any pending or scheduled dispatch entry for this instance.
    DELETE FROM fsm_core.fsm_instance_and_fsm_workerlet
    WHERE fsm_instance_id = input_fsm_instance_id
      AND status IN ('pending', 'scheduled');
    GET DIAGNOSTICS cancelled_count = ROW_COUNT;

    -- 4. Log
    INSERT INTO fsm_core.fsm_instance_queue_event_logs (
        fsm_instance_id,
        event_name,
        event_status,
        event_data,
        execution_finished_at
    ) VALUES (
        input_fsm_instance_id,
        'stop_worker',
        'cancelled',
        jsonb_build_object(
            'triggered_by',    'stop_event_for_fsm_worker_v2',
            'cancelled_count', cancelled_count
        ),
        fsm_core.tx_now()
    ) RETURNING fsm_instance_queue_event_log_id INTO event_log_id;

    -- 5. Return
    RETURN jsonb_build_object(
        'status',          CASE WHEN cancelled_count > 0 THEN 'cancelled' ELSE 'not_queued' END,
        'fsm_instance_id', input_fsm_instance_id,
        'cancelled_count', cancelled_count,
        'event_log_id',    event_log_id
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.stop_fsm_instance_v2(input_fsm_instance_id uuid, input_event_name text DEFAULT 'stop_fsm_instance'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
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
        fsm_core.tx_now()
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
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.verify_api_key(input_key_hash bytea)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pg_temp'
AS $function$
DECLARE
  v_id   uuid;
  v_role text;
  v_last timestamptz;
BEGIN
  SELECT k.id, k.role, k.last_used_at INTO v_id, v_role, v_last
  FROM fsm_core.api_keys k
  WHERE k.key_hash = input_key_hash AND k.revoked_at IS NULL;

  IF v_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_last IS NULL OR v_last < fsm_core.tx_now() - interval '1 minute' THEN
    UPDATE fsm_core.api_keys SET last_used_at = fsm_core.tx_now() WHERE id = v_id;
  END IF;

  RETURN v_role;
END;
$function$
;

-- ── Hand-written (#642): not captured by `supabase db diff` ─────────────────
-- The diff misses functions whose only change is a parameter default
-- (DEFAULT now() → DEFAULT fsm_core.tx_now()), so these three are copied
-- verbatim from supabase/schemas/. CREATE OR REPLACE resets SECURITY DEFINER
-- and search_path, so the ALTERs from the access-control file follow.

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
    input_execution_started_at timestamp with time zone DEFAULT fsm_core.tx_now(),
    input_execution_duration integer DEFAULT NULL,
    input_execution_finished_at timestamp with time zone DEFAULT fsm_core.tx_now(),
    input_event_source jsonb DEFAULT NULL
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
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fsm_core.send_event_to_async_operation_queue_with_event_logs_v2(
    input_async_operation_queue_name text,
    input_async_operation_fn_name text,
    input_async_operation_queue_type text,
    input_async_operation_queue_version text,
    input_send_to_parent_queue_id uuid,
    input_send_to_parent_queue_type text,
    input_send_to_parent_queue_id_event_name text,
    input_event_name text,
    input_event_action_type text,
    input_event_data jsonb,
    input_event_delay integer DEFAULT 0,
    input_event_status text DEFAULT 'ACTIVE',
    input_event_output jsonb DEFAULT '{}'::jsonb,
    input_error_message text DEFAULT NULL,
    input_execution_started_at timestamp with time zone DEFAULT fsm_core.tx_now(),
    input_execution_duration integer DEFAULT NULL,
    input_execution_finished_at timestamp with time zone DEFAULT fsm_core.tx_now()
)
RETURNS JSONB
AS $$
DECLARE
    queue_msg_data jsonb;
    output_async_operation_queue_msg_id bigint;
    output_async_operation_queue_event_log_id uuid;
BEGIN
    IF input_async_operation_queue_name IS NULL THEN
        RAISE EXCEPTION 'async_operation_queue_name is NULL';
    END IF;

    queue_msg_data := jsonb_build_object(
        'eventData', jsonb_build_object(
            'eventType',    input_event_name,
            'eventPayload', input_event_data,
            'actionType',   input_event_action_type
        ),
        'queueId',                    input_async_operation_queue_name,
        'queueFnName',                input_async_operation_fn_name,
        'queueType',                  input_async_operation_queue_type,
        'queueVersion',               input_async_operation_queue_version,
        'sendToParentQueueId',        input_send_to_parent_queue_id,
        'sendToParentQueueType',      input_send_to_parent_queue_type,
        'sendToParentQueueIdEventName', input_send_to_parent_queue_id_event_name
    );

    BEGIN
        SELECT pgmq.send(queue_name := input_async_operation_queue_name, msg := queue_msg_data, delay := input_event_delay)
        INTO output_async_operation_queue_msg_id;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'pgmq.send failed for queue %: %', input_async_operation_queue_name, SQLERRM;
    END;

    IF output_async_operation_queue_msg_id IS NULL THEN
        RAISE EXCEPTION 'Failed to send event to queue %', input_async_operation_queue_name;
    END IF;

    -- Append queueMsgId to queue_msg_data
    queue_msg_data := queue_msg_data || jsonb_build_object('queueMsgId', output_async_operation_queue_msg_id);

    -- Append queueMsgDelay to queue_msg_data
    queue_msg_data := queue_msg_data || jsonb_build_object('queueMsgDelay', input_event_delay);


    INSERT INTO fsm_core.fsm_async_operation_queue_event_logs (
        async_operation_queue_name,
        async_operation_fn_name,
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
        input_async_operation_fn_name,
        input_async_operation_queue_type,
        input_async_operation_queue_version,
        output_async_operation_queue_msg_id,
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
        'queue_data', queue_msg_data,
        -- 'queue_msg_id', output_async_operation_queue_msg_id,
        -- 'queue_msg_delay', input_event_delay,
        'queue_event_log_id', output_async_operation_queue_event_log_id,
        'event_status', input_event_status,
        'event_output', input_event_output,
        'error_message', input_error_message
    );
END;
$$ LANGUAGE plpgsql;

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
    input_execution_finished_at timestamp with time zone DEFAULT fsm_core.tx_now(),
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

ALTER FUNCTION fsm_core.send_event_to_fsm_queue_with_event_logs_v2 SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.finish_async_operation_event_v2 SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;

-- ── Clock seam grants (access-control file) ─────────────────────────────────
REVOKE EXECUTE ON FUNCTION fsm_core.tx_now(), fsm_core.wall_now() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fsm_core.tx_now(), fsm_core.wall_now() TO fsm_worker;
