-- fsm_core.claim_scheduled_for_async_operation_workerlet
-- Atomically claims and deletes one 'scheduled' dispatch entry assigned to
-- the given workerlet. Returns the row as JSONB, or NULL if nothing is
-- waiting (spurious notify or already claimed by another coroutine).
-- FOR UPDATE SKIP LOCKED prevents double-claim under concurrent callers.

CREATE OR REPLACE FUNCTION fsm_core.claim_scheduled_for_async_operation_workerlet(
  input_workerlet_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
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
$$;
