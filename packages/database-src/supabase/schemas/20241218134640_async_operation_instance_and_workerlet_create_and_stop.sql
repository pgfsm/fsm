-- fsm_core.create_async_operation_instance_and_notify_async_operation_scheduler_work
-- Inserts a row into async_operation_instance_and_async_operation_workerlet
-- and wakes the async-operation-scheduler via pg_notify. Mirrors
-- fsm_core.enqueue_fsm_dispatch_v2 on the FSM side. Application code should
-- call this (via createAsyncOperationInstanceAndNotifyAsyncOperationSchedulerWork
-- in fsm-core-db-ts) rather than
-- inserting into the table directly, to keep the insert and the notify atomic.
CREATE OR REPLACE FUNCTION fsm_core.create_async_operation_instance_and_notify_async_operation_scheduler_work(
  input_async_operation_instance_id uuid,
  input_async_operation_name        text,
  input_async_operation_version     text,
  input_async_operation_type        text,
  input_parent_fsm_name             text,
  input_parent_fsm_version          text,
  input_async_operation_language    text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO fsm_core.async_operation_instance_and_async_operation_workerlet (
    async_operation_instance_id,
    async_operation_name,
    async_operation_version,
    async_operation_type,
    parent_fsm_name,
    parent_fsm_version,
    async_operation_language
  )
  VALUES (
    input_async_operation_instance_id,
    input_async_operation_name,
    input_async_operation_version,
    input_async_operation_type,
    input_parent_fsm_name,
    input_parent_fsm_version,
    input_async_operation_language
  );

  PERFORM pg_notify(
    'async_operation_scheduler_work',
    input_async_operation_instance_id::text
  );
END;
$$;
