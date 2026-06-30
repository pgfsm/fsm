-- Better filename would be: 20250119124737_fsm_schedule_next_pending.sql
--
-- fsm_core.schedule_next_pending
-- Atomically claims the oldest pending dispatch entry, selects the best
-- available fsmlet (filter: heartbeat fresh + has module loaded + has free
-- slot; score: most free slots), assigns the entry, and notifies the fsmlet
-- via pg_notify — all in one transaction.
--
-- Returns TRUE if an entry was scheduled, FALSE if the queue is empty or
-- no fsmlet has capacity. Safe to call from multiple scheduler replicas
-- concurrently — FOR UPDATE SKIP LOCKED prevents double-assignment.

CREATE OR REPLACE FUNCTION fsm_core.schedule_next_pending(
  input_stale_threshold_seconds int DEFAULT 30
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_entry_id          bigint;
  v_instance_id       text;
  v_fsm_name          text;
  v_fsm_version       text;
  v_chosen_fsmlet_id  text;
BEGIN
  -- Step 1: claim the oldest pending entry (SKIP LOCKED = safe for parallel schedulers).
  SELECT id, instance_id, fsm_name, fsm_version
  INTO v_entry_id, v_instance_id, v_fsm_name, v_fsm_version
  FROM fsm_core.fsm_dispatch_queue
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
  SELECT daemon_id
  INTO v_chosen_fsmlet_id
  FROM fsm_core.fsm_daemon_node
  WHERE
    last_heartbeat > NOW() - (input_stale_threshold_seconds || ' seconds')::interval
    AND active_workers < max_concurrency
    AND fsm_modules @> jsonb_build_array(
          jsonb_build_object('fsmName', v_fsm_name, 'fsmVersion', v_fsm_version)
        )
  ORDER BY (max_concurrency - active_workers) DESC
  LIMIT 1;

  IF v_chosen_fsmlet_id IS NULL THEN
    -- No capable fsmlet right now — leave status=pending, retry on next cycle.
    RETURN false;
  END IF;

  -- Step 3: assign the entry to the chosen fsmlet.
  UPDATE fsm_core.fsm_dispatch_queue
  SET
    status              = 'scheduled',
    scheduled_fsmlet_id = v_chosen_fsmlet_id,
    scheduled_at        = NOW()
  WHERE id = v_entry_id;

  -- Step 4: wake the fsmlet via pg_notify.
  PERFORM pg_notify('fsm_fsmlet_work_' || v_chosen_fsmlet_id, v_instance_id);

  RETURN true;
END;
$$;
