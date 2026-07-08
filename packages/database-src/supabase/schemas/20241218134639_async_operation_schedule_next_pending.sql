-- fsm_core.async_operation_schedule_next_pending
-- Atomically claims the oldest pending dispatch entry, selects the best
-- available async-operation workerlet (filter: heartbeat fresh + supports this
-- specific async operation + has a free slot; score: most free slots), assigns
-- the entry, and notifies the workerlet via pg_notify — all in one transaction.
--
-- Returns TRUE if an entry was scheduled, FALSE if the queue is empty or
-- no workerlet has capacity. Safe to call from multiple scheduler replicas
-- concurrently — FOR UPDATE SKIP LOCKED prevents double-assignment.

CREATE OR REPLACE FUNCTION fsm_core.async_operation_schedule_next_pending(
  input_stale_threshold_seconds int DEFAULT 30
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
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
  PERFORM pg_notify(
    'async_operation_workerlet_work_' || v_chosen_workerlet_id::text,
    v_instance_id::text
  );

  RETURN true;
END;
$$;
