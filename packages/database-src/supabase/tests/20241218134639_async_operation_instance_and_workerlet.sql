begin;
select plan(15);

select has_table('fsm_core', 'async_operation_instance_and_async_operation_workerlet',
  'fsm_core.async_operation_instance_and_async_operation_workerlet exists');
select col_is_pk('fsm_core', 'async_operation_instance_and_async_operation_workerlet',
  'async_operation_instance_and_async_operation_workerlet_id', 'the surrogate id is the primary key');
select has_column('fsm_core', 'async_operation_instance_and_async_operation_workerlet',
  'async_operation_instance_id', 'has async_operation_instance_id column');
select has_column('fsm_core', 'async_operation_instance_and_async_operation_workerlet',
  'async_operation_workerlet_id', 'has async_operation_workerlet_id column');
select has_column('fsm_core', 'async_operation_instance_and_async_operation_workerlet',
  'async_operation_name', 'has async_operation_name column');
select has_column('fsm_core', 'async_operation_instance_and_async_operation_workerlet',
  'async_operation_version', 'has async_operation_version column');
select has_column('fsm_core', 'async_operation_instance_and_async_operation_workerlet',
  'async_operation_type', 'has async_operation_type column');
select has_column('fsm_core', 'async_operation_instance_and_async_operation_workerlet',
  'parent_fsm_name', 'has parent_fsm_name column');
select has_column('fsm_core', 'async_operation_instance_and_async_operation_workerlet',
  'parent_fsm_version', 'has parent_fsm_version column');
select has_column('fsm_core', 'async_operation_instance_and_async_operation_workerlet',
  'async_operation_language', 'has async_operation_language column');
select has_column('fsm_core', 'async_operation_instance_and_async_operation_workerlet',
  'status', 'has status column');
select has_column('fsm_core', 'async_operation_instance_and_async_operation_workerlet',
  'created_at', 'has created_at column');
select has_column('fsm_core', 'async_operation_instance_and_async_operation_workerlet',
  'scheduled_at', 'has scheduled_at column');
select has_index('fsm_core', 'async_operation_instance_and_async_operation_workerlet',
  'idx_async_operation_instance_and_workerlet_pending', 'partial index on pending rows exists');
select has_index('fsm_core', 'async_operation_instance_and_async_operation_workerlet',
  'idx_async_operation_instance_and_workerlet_scheduled', 'partial index on scheduled rows exists');

select * from finish();
rollback;
