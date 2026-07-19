begin;
select plan(5);

select has_function('fsm_core', 'archive_event_from_fsm_promise_type_worker_v2',
  ARRAY['text', 'text', 'text', 'bigint', 'text', 'text', 'jsonb', 'integer', 'uuid', 'text', 'timestamptz', 'integer', 'timestamptz', 'text', 'jsonb', 'text'],
  'archive_event_from_fsm_promise_type_worker_v2(...) exists');

delete from fsm_core.fsm_promise_queue_event_logs where promise_queue_name = 'archPromiseQ1';
delete from fsm_core.fsm_instance_queue_event_logs
  where fsm_instance_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid;
delete from fsm_core.fsm_instance where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid;
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version)
values ('dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid, 'archFsm', 'v1');
select pgmq.create(queue_name := 'dddddddd-dddd-dddd-dddd-dddddddddddd');
select pgmq.create(queue_name := 'archPromiseQ1');
select pgmq.send(queue_name := 'archPromiseQ1', msg := '{"foo": "bar"}'::jsonb);

select results_eq(
  $$ select (r->>'promise_queue_archive_result')::boolean, (r->>'promise_queue_name'),
            (r->>'promise_queue_msg_id')::bigint, (r->'send_to_parent_result'->'queue_data'->'eventData'->>'eventType')
     from fsm_core.archive_event_from_fsm_promise_type_worker_v2(
       'archPromiseQ1', 'promise', 'v1', 1::bigint,
       'promiseDone', 'promise', '{"result": "ok"}'::jsonb, 0,
       'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid, 'promiseDoneEvt',
       now(), NULL, now(), 'success', '{"result": "ok"}'::jsonb, NULL) r $$,
  $$ values (true, 'archPromiseQ1'::text, 1::bigint, 'promiseDone'::text) $$,
  'archiving a completed promise event: message archived, and forwarded to the parent FSM queue'
);
select results_eq(
  $$ select event_name, event_data, event_status from fsm_core.fsm_promise_queue_event_logs
     where promise_queue_name = 'archPromiseQ1' $$,
  $$ values ('promiseDone'::text, '{"result": "ok"}'::jsonb, 'success'::text) $$,
  'the archive is logged in fsm_promise_queue_event_logs'
);
select results_eq(
  $$ select event_name, event_data, event_status from fsm_core.fsm_instance_queue_event_logs
     where fsm_instance_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid $$,
  $$ values ('promiseDone'::text, '{"result": "ok"}'::jsonb, 'success'::text) $$,
  'the forwarded event is also logged against the parent fsm_instance queue'
);

select throws_ok(
  $$ select fsm_core.archive_event_from_fsm_promise_type_worker_v2(
       'neverCreatedPromiseQ', 'promise', 'v1', 1::bigint,
       'promiseDone', 'promise', '{}'::jsonb, 0,
       'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid, 'promiseDoneEvt',
       now(), NULL, now(), 'success', '{}'::jsonb, NULL) $$,
  '42P01',
  'relation "pgmq.q_nevercreatedpromiseq" does not exist',
  'archiving from a queue that was never created raises the raw pgmq relation-not-found error (not wrapped)'
);

select * from finish();
rollback;
