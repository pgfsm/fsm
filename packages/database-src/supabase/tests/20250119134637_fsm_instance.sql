begin;
select plan(32);

-- fsm_core.fsm_instance
select has_table('fsm_core', 'fsm_instance', 'fsm_core.fsm_instance exists');
select col_is_pk('fsm_core', 'fsm_instance', 'id', 'fsm_instance.id is the primary key');
select has_column('fsm_core', 'fsm_instance', 'fsm_name', 'has fsm_name column');
select has_column('fsm_core', 'fsm_instance', 'fsm_version', 'has fsm_version column');
select has_column('fsm_core', 'fsm_instance', 'fsm_type', 'has fsm_type column');
select col_type_is('fsm_core', 'fsm_instance', 'fsm_instance_context', 'jsonb', 'fsm_instance_context is jsonb');
select col_type_is('fsm_core', 'fsm_instance', 'fsm_instance_state', 'jsonb', 'fsm_instance_state is jsonb');
select col_type_is('fsm_core', 'fsm_instance', 'fsm_instance_status', 'jsonb', 'fsm_instance_status is jsonb');
select col_type_is('fsm_core', 'fsm_instance', 'fsm_instance_output', 'jsonb', 'fsm_instance_output is jsonb');
select col_type_is('fsm_core', 'fsm_instance', 'fsm_instance_error', 'jsonb', 'fsm_instance_error is jsonb');
select col_type_is('fsm_core', 'fsm_instance', 'fsm_instance_xstate_state', 'jsonb', 'fsm_instance_xstate_state is jsonb');
select has_column('fsm_core', 'fsm_instance', 'total_schedule_queue_data', 'has total_schedule_queue_data column');
select has_column('fsm_core', 'fsm_instance', 'total_promise_queue_data', 'has total_promise_queue_data column');
select col_type_is('fsm_core', 'fsm_instance', 'parent', 'uuid', 'parent is uuid');
select has_column('fsm_core', 'fsm_instance', 'childrens', 'has childrens column');
select has_column('fsm_core', 'fsm_instance', 'started_at', 'has started_at column');
select has_column('fsm_core', 'fsm_instance', 'ended_at', 'has ended_at column');
select col_type_is('fsm_core', 'fsm_instance', 'worker_locked', 'boolean', 'worker_locked is boolean');
select has_column('fsm_core', 'fsm_instance', 'worker_locked_by', 'has worker_locked_by column');
select has_column('fsm_core', 'fsm_instance', 'worker_locked_at', 'has worker_locked_at column');
select has_column('fsm_core', 'fsm_instance', 'worker_lock_expires_at', 'has worker_lock_expires_at column');

-- fsm_core.fsm_instance_transitions_auth
select has_table('fsm_core', 'fsm_instance_transitions_auth', 'fsm_core.fsm_instance_transitions_auth exists');
select has_column('fsm_core', 'fsm_instance_transitions_auth', 'fsm_name', 'has fsm_name column');
select has_column('fsm_core', 'fsm_instance_transitions_auth', 'fsm_version', 'has fsm_version column');
select has_column('fsm_core', 'fsm_instance_transitions_auth', 'fsm_type', 'has fsm_type column');
select col_type_is('fsm_core', 'fsm_instance_transitions_auth', 'fsm_instance_id', 'uuid', 'fsm_instance_id is uuid');
select fk_ok('fsm_core', 'fsm_instance_transitions_auth', 'fsm_instance_id', 'fsm_core', 'fsm_instance', 'id',
  'fsm_instance_id references fsm_core.fsm_instance(id)');
select has_column('fsm_core', 'fsm_instance_transitions_auth', 'fsm_instance_event_type', 'has fsm_instance_event_type column');
select col_type_is('fsm_core', 'fsm_instance_transitions_auth', 'users', 'jsonb[]', 'users is jsonb[]');
select col_type_is('fsm_core', 'fsm_instance_transitions_auth', 'groups', 'jsonb[]', 'groups is jsonb[]');
select has_column('fsm_core', 'fsm_instance_transitions_auth', 'module_tag', 'has module_tag column');
select has_column('fsm_core', 'fsm_instance_transitions_auth', 'meta_info', 'has meta_info column');

select * from finish();
rollback;
