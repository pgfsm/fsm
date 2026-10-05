begin;
select plan(18);

select has_table('fsm_core', 'fsm_async_operation_queue_event_logs', 'fsm_core.fsm_async_operation_queue_event_logs exists');
select col_is_pk('fsm_core', 'fsm_async_operation_queue_event_logs', 'async_operation_queue_event_log_id',
  'async_operation_queue_event_log_id is the primary key');
select has_column('fsm_core', 'fsm_async_operation_queue_event_logs', 'async_operation_queue_name', 'has async_operation_queue_name column');
select has_column('fsm_core', 'fsm_async_operation_queue_event_logs', 'async_operation_fn_name', 'has async_operation_fn_name column');
select has_column('fsm_core', 'fsm_async_operation_queue_event_logs', 'async_operation_queue_type', 'has async_operation_queue_type column');
select has_column('fsm_core', 'fsm_async_operation_queue_event_logs', 'async_operation_queue_version', 'has async_operation_queue_version column');
select has_column('fsm_core', 'fsm_async_operation_queue_event_logs', 'async_operation_queue_msg_id', 'has async_operation_queue_msg_id column');
select has_column('fsm_core', 'fsm_async_operation_queue_event_logs', 'event_name', 'has event_name column');
select col_type_is('fsm_core', 'fsm_async_operation_queue_event_logs', 'event_data', 'jsonb', 'event_data is jsonb');
select has_column('fsm_core', 'fsm_async_operation_queue_event_logs', 'event_delay', 'has event_delay column');
-- No FK on purpose: system queues (pg_system_queue_uuid(), api_system_queue_uuid())
-- aren't fsm_instance rows — see the column's comment in the schema file.
select col_isnt_fk('fsm_core', 'fsm_async_operation_queue_event_logs', 'send_to_parent_queue_id',
  'send_to_parent_queue_id has no FK, so system queue ids are allowed');
select has_column('fsm_core', 'fsm_async_operation_queue_event_logs', 'send_to_parent_queue_id_event_name', 'has send_to_parent_queue_id_event_name column');
select has_column('fsm_core', 'fsm_async_operation_queue_event_logs', 'execution_started_at', 'has execution_started_at column');
select has_column('fsm_core', 'fsm_async_operation_queue_event_logs', 'execution_duration', 'has execution_duration column');
select has_column('fsm_core', 'fsm_async_operation_queue_event_logs', 'execution_finished_at', 'has execution_finished_at column');
select has_column('fsm_core', 'fsm_async_operation_queue_event_logs', 'event_status', 'has event_status column');
select col_type_is('fsm_core', 'fsm_async_operation_queue_event_logs', 'event_output', 'jsonb', 'event_output is jsonb');
select has_column('fsm_core', 'fsm_async_operation_queue_event_logs', 'error_message', 'has error_message column');

select * from finish();
rollback;
