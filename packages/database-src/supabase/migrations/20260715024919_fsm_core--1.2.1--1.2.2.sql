set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.claim_scheduled_for_async_operation_workerlet(input_workerlet_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  WITH claimed AS (
    DELETE FROM fsm_core.async_operation_instance_and_async_operation_workerlet
    WHERE async_operation_instance_and_async_operation_workerlet_id = (
      SELECT async_operation_instance_and_async_operation_workerlet_id
      FROM fsm_core.async_operation_instance_and_async_operation_workerlet
      WHERE status = 'scheduled'
        AND async_operation_workerlet_id = input_workerlet_id
      ORDER BY scheduled_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  )
  SELECT row_to_json(claimed.*)::jsonb INTO v_result FROM claimed;
  RETURN v_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.async_operation_schedule_next_pending(input_stale_threshold_seconds integer DEFAULT 30)
 RETURNS boolean
 LANGUAGE plpgsql
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
    last_heartbeat > NOW() - (input_stale_threshold_seconds || ' seconds')::interval
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
    scheduled_at                 = NOW()
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

CREATE OR REPLACE FUNCTION fsm_core.load_async_operation_meta_v2(input_async_operation_name text, input_async_operation_version text, input_async_operation_type text, input_async_operation_language text, input_parent_fsm_name text, input_parent_fsm_version text, input_updated_by_pid text)
 RETURNS jsonb
 LANGUAGE plpgsql
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
    updated_at             = now(),
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


