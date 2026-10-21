begin;
select plan(4);

select has_function('fsm_core', 'log_async_operation_cancel_ack_v2',
  ARRAY['text', 'bigint', 'text', 'text', 'text', 'integer'],
  'log_async_operation_cancel_ack_v2(...) exists (#539)');

create temp table ack539 as
select fsm_core.log_async_operation_cancel_ack_v2(
  'Ack539_Queue', 7::bigint, 'invoke-1', 'STATE_EXITED', 'aborted', 42) as id;

select results_eq(
  $$ select l.event_name, l.event_status, l.async_operation_queue_name, l.async_operation_queue_msg_id, l.event_data
     from fsm_core.fsm_async_operation_queue_event_logs l, ack539
     where l.async_operation_queue_event_log_id = ack539.id $$,
  $$ values ('cancel_ack'::text, 'cancel_acknowledged'::text, 'Ack539_Queue'::text, 7::bigint,
             '{"invoke_id": "invoke-1", "reason": "STATE_EXITED", "outcome": "aborted", "cancel_to_ack_ms": 42}'::jsonb) $$,
  'an acknowledgement is one cancel_acknowledged row with the invoke id, reason, outcome and latency (#539)'
);
select throws_ok(
  $$ select fsm_core.log_async_operation_cancel_ack_v2('q', 1::bigint, 'i', 'TIMEOUT', 'ignored', 1) $$,
  'P0001',
  'log_async_operation_cancel_ack_v2: the outcome must be aborted, completed or failed, not ignored',
  'an unknown outcome raises (#539)'
);
select ok(
  has_function_privilege('fsm_worker', 'fsm_core.log_async_operation_cancel_ack_v2(text, bigint, text, text, text, integer)', 'execute')
    and not has_function_privilege('public', 'fsm_core.log_async_operation_cancel_ack_v2(text, bigint, text, text, text, integer)', 'execute'),
  'the gateway''s role may call it; PUBLIC may not (#539)'
);

select * from finish();
rollback;
