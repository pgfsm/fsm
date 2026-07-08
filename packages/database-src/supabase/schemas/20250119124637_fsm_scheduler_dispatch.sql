-- fsm_core.enqueue_fsm_dispatch_v1  (NOT USED — superseded by v2)
-- Original pgmq-based dispatch: sends the instance to
-- master_worker_dispatch_queue for the worker daemon to poll.
-- Preserved for historical reference only.
CREATE OR REPLACE FUNCTION fsm_core.enqueue_fsm_dispatch_v1(
  input_instance_id   text,
  input_fsm_name      text,
  input_fsm_version   text,
  input_dispatch_type text DEFAULT 'start'
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  dispatch_queue_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'master_worker_dispatch_queue_start'
  ) INTO dispatch_queue_exists;

  IF NOT dispatch_queue_exists THEN
    PERFORM pgmq.create(queue_name := 'master_worker_dispatch_queue_start');
  END IF;

  PERFORM pgmq.send(
    queue_name := 'master_worker_dispatch_queue_start',
    msg        := jsonb_build_object(
      'id',          input_instance_id,
      'fsm_name',    input_fsm_name,
      'fsm_version', input_fsm_version
    )
  );
END;
$$;


-- fsm_core.enqueue_fsm_dispatch_v2
-- Inserts a row into fsm_instance_and_fsm_workerlet and wakes the fsmscheduler via
-- pg_notify. Called from create_fsm_instance_from_name_v2, the API server,
-- and fsmctl for both 'start' (new instance) and 'resume' (existing instance
-- resuming after an await).
CREATE OR REPLACE FUNCTION fsm_core.enqueue_fsm_dispatch_v2(
  input_instance_id   uuid,
  input_fsm_name      text,
  input_fsm_version   text,
  input_dispatch_type text DEFAULT 'start'
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO fsm_core.fsm_instance_and_fsm_workerlet (fsm_instance_id, fsm_name, fsm_version, dispatch_type)
  VALUES (input_instance_id, input_fsm_name, input_fsm_version, input_dispatch_type);

  PERFORM pg_notify('fsm_scheduler_work', input_instance_id::text);
END;
$$;
