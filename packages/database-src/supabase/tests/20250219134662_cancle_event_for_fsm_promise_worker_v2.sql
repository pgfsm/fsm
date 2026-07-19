begin;
select plan(5);

select has_function('fsm_core', 'cancel_event_for_fsm_promise_type_worker_v2', ARRAY['text', 'bigint'],
  'cancel_event_for_fsm_promise_type_worker_v2(text, bigint) exists');

delete from fsm_core.fsm_promise_queue_event_logs where promise_queue_name in ('cancelQ1', 'cancelQ2');
select pgmq.create(queue_name := 'cancelQ1');
select pgmq.send(queue_name := 'cancelQ1', msg := '{"foo": "bar"}'::jsonb);

select results_eq(
  $$ select fsm_core.cancel_event_for_fsm_promise_type_worker_v2('cancelQ1', 1::bigint) $$,
  $$ values ('{"status": "canceled", "queue_msg_id": 1, "archive_result": true, "promise_queue_name": "cancelQ1"}'::jsonb) $$,
  'canceling an existing queued message archives it and reports archive_result=true'
);
select results_eq(
  $$ select event_name, promise_queue_msg_id, event_status from fsm_core.fsm_promise_queue_event_logs
     where promise_queue_name = 'cancelQ1' $$,
  $$ values ('cancel'::text, 1::bigint, 'canceled'::text) $$,
  'a cancel event is logged in fsm_promise_queue_event_logs'
);

select pgmq.create(queue_name := 'cancelQ2');
select results_eq(
  $$ select (fsm_core.cancel_event_for_fsm_promise_type_worker_v2('cancelQ2', 999::bigint) ->> 'archive_result')::boolean $$,
  $$ values (false) $$,
  'canceling a message id that does not exist in an otherwise-valid queue reports archive_result=false (no exception)'
);
select throws_ok(
  $$ select fsm_core.cancel_event_for_fsm_promise_type_worker_v2('neverCreatedQueue', 1::bigint) $$,
  '42P01',
  'relation "pgmq.q_nevercreatedqueue" does not exist',
  'canceling against a queue that was never created raises the raw pgmq relation-not-found error (not wrapped)'
);

select * from finish();
rollback;
