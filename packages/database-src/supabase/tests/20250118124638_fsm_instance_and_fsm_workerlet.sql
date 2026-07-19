begin;
select plan(12);

select has_table('fsm_core', 'fsm_instance_and_fsm_workerlet', 'fsm_core.fsm_instance_and_fsm_workerlet exists');
select col_is_pk('fsm_core', 'fsm_instance_and_fsm_workerlet', 'fsm_instance_and_fsm_workerlet_id',
  'the surrogate id is the primary key');
select has_column('fsm_core', 'fsm_instance_and_fsm_workerlet', 'fsm_instance_id', 'has fsm_instance_id column');
select has_column('fsm_core', 'fsm_instance_and_fsm_workerlet', 'fsm_workerlet_id', 'has fsm_workerlet_id column');
select has_column('fsm_core', 'fsm_instance_and_fsm_workerlet', 'fsm_name', 'has fsm_name column');
select has_column('fsm_core', 'fsm_instance_and_fsm_workerlet', 'fsm_version', 'has fsm_version column');
select has_column('fsm_core', 'fsm_instance_and_fsm_workerlet', 'dispatch_type', 'has dispatch_type column');
select has_column('fsm_core', 'fsm_instance_and_fsm_workerlet', 'status', 'has status column');
select has_column('fsm_core', 'fsm_instance_and_fsm_workerlet', 'created_at', 'has created_at column');
select has_column('fsm_core', 'fsm_instance_and_fsm_workerlet', 'scheduled_at', 'has scheduled_at column');
select has_index('fsm_core', 'fsm_instance_and_fsm_workerlet', 'idx_fsm_instance_and_fsm_workerlet_pending',
  'partial index on pending rows exists');
select has_index('fsm_core', 'fsm_instance_and_fsm_workerlet', 'idx_fsm_instance_and_fsm_workerlet_scheduled',
  'partial index on scheduled rows exists');

select * from finish();
rollback;
