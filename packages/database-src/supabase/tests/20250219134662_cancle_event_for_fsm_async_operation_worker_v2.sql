begin;
select plan(6);

select has_function('fsm_core', 'cancel_event_for_fsm_async_operation_type_worker_v2', ARRAY['text', 'bigint'],
  'cancel_event_for_fsm_async_operation_type_worker_v2(text, bigint) exists');

delete from fsm_core.fsm_async_operation_queue_event_logs where async_operation_queue_name in ('cancelQ1', 'cancelQ2', 'creditCheck_v01_i_verifyCredentials_t');
select pgmq.create(queue_name := 'cancelQ1');
select pgmq.send(queue_name := 'cancelQ1', msg := '{"foo": "bar"}'::jsonb);

select results_eq(
  $$ select fsm_core.cancel_event_for_fsm_async_operation_type_worker_v2('cancelQ1', 1::bigint) $$,
  $$ values ('{"status": "canceled", "queue_msg_id": 1, "archive_result": true, "async_operation_queue_name": "cancelQ1"}'::jsonb) $$,
  'canceling an existing queued message archives it and reports archive_result=true'
);
select results_eq(
  $$ select event_name, async_operation_queue_msg_id, event_status from fsm_core.fsm_async_operation_queue_event_logs
     where async_operation_queue_name = 'cancelQ1' $$,
  $$ values ('cancel'::text, 1::bigint, 'canceled'::text) $$,
  'a cancel event is logged in fsm_async_operation_queue_event_logs'
);

select pgmq.create(queue_name := 'cancelQ2');
select results_eq(
  $$ select (fsm_core.cancel_event_for_fsm_async_operation_type_worker_v2('cancelQ2', 999::bigint) ->> 'archive_result')::boolean $$,
  $$ values (false) $$,
  'canceling a message id that does not exist in an otherwise-valid queue reports archive_result=false (no exception)'
);
select throws_ok(
  $$ select fsm_core.cancel_event_for_fsm_async_operation_type_worker_v2('neverCreatedQueue', 1::bigint) $$,
  '42P01',
  'relation "pgmq.q_nevercreatedqueue" does not exist',
  'canceling against a queue that was never created raises the raw pgmq relation-not-found error (not wrapped)'
);

-- #512: a real actor queue name of 37 characters made the old notify channel
-- ('fsm_async_operation_worker_' || name) 64 bytes, over PostgreSQL's limit.
select pgmq.create(queue_name := 'creditCheck_v01_i_verifyCredentials_t');
select pgmq.send(queue_name := 'creditCheck_v01_i_verifyCredentials_t', msg := '{"foo": "bar"}'::jsonb);
select results_eq(
  $$ select (fsm_core.cancel_event_for_fsm_async_operation_type_worker_v2('creditCheck_v01_i_verifyCredentials_t', 1::bigint) ->> 'archive_result')::boolean $$,
  $$ values (true) $$,
  'canceling on a queue name of 37+ characters works (#512)'
);

select * from finish();
rollback;
