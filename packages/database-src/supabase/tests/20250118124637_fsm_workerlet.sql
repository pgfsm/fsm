begin;
select plan(8);

select has_table('fsm_core', 'fsm_workerlet', 'fsm_core.fsm_workerlet exists');
select col_is_pk('fsm_core', 'fsm_workerlet', 'fsm_workerlet_id', 'fsm_workerlet_id is the primary key');
select has_column('fsm_core', 'fsm_workerlet', 'fsm_workerlet_pid', 'has fsm_workerlet_pid column');
select col_type_is('fsm_core', 'fsm_workerlet', 'fsm_modules', 'jsonb', 'fsm_modules is jsonb');
select has_column('fsm_core', 'fsm_workerlet', 'max_concurrency', 'has max_concurrency column');
select has_column('fsm_core', 'fsm_workerlet', 'active_workers', 'has active_workers column');
select has_column('fsm_core', 'fsm_workerlet', 'last_heartbeat', 'has last_heartbeat column');
select has_column('fsm_core', 'fsm_workerlet', 'registered_at', 'has registered_at column');

select * from finish();
rollback;
