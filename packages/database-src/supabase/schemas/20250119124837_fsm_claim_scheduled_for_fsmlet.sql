-- fsm_core.claim_scheduled_for_fsmlet
-- Called by a fsmlet after it receives a pg_notify on its per-fsmlet channel.
-- Atomically claims one 'scheduled' dispatch entry assigned to this fsmlet and
-- deletes it from fsm_instance_and_fsm_workerlet.
--
-- The dispatch row is deleted immediately — the fsmlet's in-memory activeWorkers
-- map tracks what is running; fsm_instance tracks FSM lifecycle state.
--
-- Returns a JSONB object with the claimed entry, or NULL if nothing is waiting
-- (spurious notify or already claimed by another coroutine on the same fsmlet).
-- Safe to call concurrently from multiple coroutines on the same fsmlet —
-- FOR UPDATE SKIP LOCKED prevents double-claiming.

CREATE OR REPLACE FUNCTION fsm_core.claim_scheduled_for_fsmlet(
  input_fsmlet_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_entry_id      uuid;
  v_instance_id   uuid;
  v_fsm_name      text;
  v_fsm_version   text;
  v_dispatch_type text;
BEGIN
  -- Claim one scheduled entry for this fsmlet (SKIP LOCKED = safe for parallel coroutines).
  SELECT
    fsm_instance_and_fsm_workerlet_id,
    fsm_instance_id,
    fsm_name,
    fsm_version,
    dispatch_type
  INTO v_entry_id, v_instance_id, v_fsm_name, v_fsm_version, v_dispatch_type
  FROM fsm_core.fsm_instance_and_fsm_workerlet
  WHERE status = 'scheduled'
    AND fsm_workerlet_id = input_fsmlet_id
  ORDER BY scheduled_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_entry_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Delete the row — in-memory activeWorkers map on the fsmlet tracks what's running.
  DELETE FROM fsm_core.fsm_instance_and_fsm_workerlet
  WHERE fsm_instance_and_fsm_workerlet_id = v_entry_id;

  RETURN jsonb_build_object(
    'fsm_instance_and_fsm_workerlet_id', v_entry_id,
    'fsm_instance_id',                   v_instance_id,
    'fsm_name',                          v_fsm_name,
    'fsm_version',                       v_fsm_version,
    'dispatch_type',                     v_dispatch_type
  );
END;
$$;
