begin;
select plan(18);

select has_table('fsm_core', 'fsm_promise_queue_event_logs', 'fsm_core.fsm_promise_queue_event_logs exists');
select col_is_pk('fsm_core', 'fsm_promise_queue_event_logs', 'promise_queue_event_log_id',
  'promise_queue_event_log_id is the primary key');
select has_column('fsm_core', 'fsm_promise_queue_event_logs', 'promise_queue_name', 'has promise_queue_name column');
select has_column('fsm_core', 'fsm_promise_queue_event_logs', 'promise_fn_name', 'has promise_fn_name column');
select has_column('fsm_core', 'fsm_promise_queue_event_logs', 'promise_queue_type', 'has promise_queue_type column');
select has_column('fsm_core', 'fsm_promise_queue_event_logs', 'promise_queue_version', 'has promise_queue_version column');
select has_column('fsm_core', 'fsm_promise_queue_event_logs', 'promise_queue_msg_id', 'has promise_queue_msg_id column');
select has_column('fsm_core', 'fsm_promise_queue_event_logs', 'event_name', 'has event_name column');
select col_type_is('fsm_core', 'fsm_promise_queue_event_logs', 'event_data', 'jsonb', 'event_data is jsonb');
select has_column('fsm_core', 'fsm_promise_queue_event_logs', 'event_delay', 'has event_delay column');
select fk_ok('fsm_core', 'fsm_promise_queue_event_logs', 'send_to_parent_queue_id', 'fsm_core', 'fsm_instance', 'id',
  'send_to_parent_queue_id references fsm_core.fsm_instance(id)');
select has_column('fsm_core', 'fsm_promise_queue_event_logs', 'send_to_parent_queue_id_event_name', 'has send_to_parent_queue_id_event_name column');
select has_column('fsm_core', 'fsm_promise_queue_event_logs', 'execution_started_at', 'has execution_started_at column');
select has_column('fsm_core', 'fsm_promise_queue_event_logs', 'execution_duration', 'has execution_duration column');
select has_column('fsm_core', 'fsm_promise_queue_event_logs', 'execution_finished_at', 'has execution_finished_at column');
select has_column('fsm_core', 'fsm_promise_queue_event_logs', 'event_status', 'has event_status column');
select col_type_is('fsm_core', 'fsm_promise_queue_event_logs', 'event_output', 'jsonb', 'event_output is jsonb');
select has_column('fsm_core', 'fsm_promise_queue_event_logs', 'error_message', 'has error_message column');

select * from finish();
rollback;
