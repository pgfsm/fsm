begin;
select plan(8);

select has_table('fsm_core', 'async_operation_workerlet', 'fsm_core.async_operation_workerlet exists');
select col_is_pk('fsm_core', 'async_operation_workerlet', 'async_operation_workerlet_id', 'async_operation_workerlet_id is the primary key');
select has_column('fsm_core', 'async_operation_workerlet', 'async_operation_workerlet_pid', 'has async_operation_workerlet_pid column');
select col_type_is('fsm_core', 'async_operation_workerlet', 'supported_async_operations', 'jsonb', 'supported_async_operations is jsonb');
select has_column('fsm_core', 'async_operation_workerlet', 'max_pid_number', 'has max_pid_number column');
select has_column('fsm_core', 'async_operation_workerlet', 'active_pid_number', 'has active_pid_number column');
select has_column('fsm_core', 'async_operation_workerlet', 'last_heartbeat', 'has last_heartbeat column');
select has_column('fsm_core', 'async_operation_workerlet', 'registered_at', 'has registered_at column');

select * from finish();
rollback;
