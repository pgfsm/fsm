begin;
select plan(19);

select hasnt_function('fsm_core', 'archive_event_from_fsm_async_operation_type_worker_v2',
  'the deprecated archive_event_from_fsm_async_operation_type_worker_v2 wrapper is gone (#548)');

delete from fsm_core.fsm_async_operation_queue_event_logs where async_operation_queue_name = 'archAsyncOpQ1';
delete from fsm_core.fsm_instance_queue_event_logs
  where fsm_instance_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid;
delete from fsm_core.fsm_instance where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid;
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version)
values ('dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid, 'archFsm', 'v1');
select pgmq.create(queue_name := 'dddddddd-dddd-dddd-dddd-dddddddddddd');
select pgmq.create(queue_name := 'archAsyncOpQ1');
select pgmq.send(queue_name := 'archAsyncOpQ1', msg := '{"foo": "bar"}'::jsonb);

select results_eq(
  $$ select (r->>'async_operation_queue_archive_result')::boolean, (r->>'async_operation_queue_name'),
            (r->>'async_operation_queue_msg_id')::bigint, (r->'send_to_parent_result'->'queue_data'->'eventData'->>'eventType')
     from fsm_core.finish_async_operation_event_v2(
       input_archive_reason := 'completed',
       input_async_operation_queue_name := 'archAsyncOpQ1',
       input_async_operation_queue_msg_id := 1::bigint,
       input_async_operation_queue_type := 'internalAsyncOperation',
       input_async_operation_queue_version := 'v1',
       input_event_name := 'asyncOpDone',
       input_event_action_type := 'async_operation',
       input_event_data := '{"result": "ok"}'::jsonb,
       input_event_delay := 0,
       input_send_to_parent_queue_id := 'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid,
       input_send_to_parent_queue_id_event_name := 'asyncOpDoneEvt',
       input_execution_started_at := now(),
       input_execution_finished_at := now(),
       input_event_status := 'success',
       input_event_output := '{"result": "ok"}'::jsonb) r $$,
  $$ values (true, 'archAsyncOpQ1'::text, 1::bigint, 'asyncOpDone'::text) $$,
  'archiving a completed async-operation event: message archived, and forwarded to the parent FSM queue'
);
select results_eq(
  $$ select event_name, event_data, event_status from fsm_core.fsm_async_operation_queue_event_logs
     where async_operation_queue_name = 'archAsyncOpQ1' $$,
  $$ values ('asyncOpDone'::text, '{"result": "ok"}'::jsonb, 'success'::text) $$,
  'the archive is logged in fsm_async_operation_queue_event_logs'
);
select results_eq(
  $$ select event_name, event_data, event_status from fsm_core.fsm_instance_queue_event_logs
     where fsm_instance_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid $$,
  $$ values ('asyncOpDone'::text, '{"result": "ok"}'::jsonb, 'success'::text) $$,
  'the forwarded event is also logged against the parent fsm_instance queue'
);

select throws_ok(
  $$ select fsm_core.finish_async_operation_event_v2(
       input_archive_reason := 'completed',
       input_async_operation_queue_name := 'neverCreatedAsyncOpQ',
       input_async_operation_queue_msg_id := 1::bigint,
       input_event_name := 'asyncOpDone',
       input_send_to_parent_queue_id := 'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid,
       input_event_status := 'success') $$,
  '42P01',
  'relation "pgmq.q_nevercreatedasyncopq" does not exist',
  'archiving from a queue that was never created raises the raw pgmq relation-not-found error (not wrapped)'
);

-- ============================================================
-- finish_async_operation_event_v2 (SPEC-011 (a), #533)
-- ============================================================
select has_function('fsm_core', 'finish_async_operation_event_v2',
  ARRAY['text', 'text', 'bigint', 'text', 'text', 'text', 'text', 'jsonb', 'integer', 'uuid', 'text',
        'timestamptz', 'integer', 'timestamptz', 'text', 'jsonb', 'text'],
  'finish_async_operation_event_v2(...) exists (#533)');
select has_function('fsm_core', 'send_event_to_fsm_queue_with_event_logs_v2',
  ARRAY['uuid', 'text', 'text', 'text', 'text', 'jsonb', 'integer', 'text', 'jsonb', 'text',
        'timestamptz', 'integer', 'timestamptz', 'jsonb'],
  'send_event_to_fsm_queue_with_event_logs_v2 takes the event''s source (#533)');
select throws_ok(
  $$ select fsm_core.finish_async_operation_event_v2('done', 'archAsyncOpQ1', 1::bigint) $$,
  'P0001',
  'finish_async_operation_event_v2: the archive reason must be completed or cancelled, not done',
  'an archive reason other than completed or cancelled raises (#533)'
);

insert into fsm_core.fsm_instance (id, fsm_name, fsm_version)
values ('d5330000-0000-0000-0000-000000000001'::uuid, 'finFsm', 'v1');
select pgmq.create(queue_name := 'd5330000-0000-0000-0000-000000000001');
select pgmq.create(queue_name := 'fin533_v1_i_work_t');
select pgmq.send(queue_name := 'fin533_v1_i_work_t', msg := '{"invoke": 1}'::jsonb);
select pgmq.send(queue_name := 'fin533_v1_i_work_t', msg := '{"invoke": 2}'::jsonb);
select pgmq.send(queue_name := 'fin533_v1_i_work_t', msg := '{"invoke": 3}'::jsonb);

-- A completed result reaches the parent with its source, next to eventData.
create temp table fin533_done as
select fsm_core.finish_async_operation_event_v2(
  'completed', 'fin533_v1_i_work_t', 1::bigint,
  'internalAsyncOperation', 'v1', 'xstate.done.actor.0.finFsm.Working', 'xstate.invoke', '{"score": 7}'::jsonb, 0,
  'd5330000-0000-0000-0000-000000000001'::uuid, '0.finFsm.Working',
  now(), 12, now(), 'succeeded', '{"score": 7}'::jsonb, NULL) r;
select results_eq(
  $$ select (r->>'archive_result')::boolean, r->>'status', (r->>'cancel_notified')::boolean,
            r->'send_to_parent_result'->'queue_data'->'source',
            r->'send_to_parent_result'->'queue_data'->'eventData'->>'eventType'
     from fin533_done $$,
  $$ values (true, 'succeeded'::text, false,
             '{"invoke_id": "0.finFsm.Working", "queue_id": "fin533_v1_i_work_t", "queue_msg_id": 1}'::jsonb,
             'xstate.done.actor.0.finFsm.Working'::text) $$,
  'a completed result is archived and sent to the parent with its source {invoke_id, queue_id, queue_msg_id} (#533)'
);
select results_eq(
  $$ select m.message->'source'->>'invoke_id', m.message->'eventData' ? 'source'
     from pgmq.read('d5330000-0000-0000-0000-000000000001', 0, 10) m $$,
  $$ values ('0.finFsm.Working'::text, false) $$,
  'the source is on the parent''s message, next to eventData, not inside it (#533)'
);

-- The cancel wins: the late result is never sent to the parent.
select results_eq(
  $$ select (r->>'archive_result')::boolean, r->>'status', (r->>'cancel_notified')::boolean
     from fsm_core.finish_async_operation_event_v2('cancelled', 'fin533_v1_i_work_t', 2::bigint) r $$,
  $$ values (true, 'canceled'::text, true) $$,
  'a cancel that archives the message announces it (#533)'
);
select results_eq(
  $$ select (r->>'archive_result')::boolean, r->>'status', r->'send_to_parent_result'->>'reason'
     from fsm_core.finish_async_operation_event_v2(
       'completed', 'fin533_v1_i_work_t', 2::bigint,
       'internalAsyncOperation', 'v1', 'xstate.done.actor.0.finFsm.Late', 'xstate.invoke', '{}'::jsonb, 0,
       'd5330000-0000-0000-0000-000000000001'::uuid, '0.finFsm.Late',
       now(), 5, now(), 'succeeded', '{}'::jsonb, NULL) r $$,
  $$ values (false, 'discarded'::text, 'message already archived'::text) $$,
  'a result that arrives after its cancel is discarded, not sent (#533)'
);
select results_eq(
  $$ select count(*)::int from pgmq.read('d5330000-0000-0000-0000-000000000001', 0, 10) m
     where m.message->'eventData'->>'eventType' = 'xstate.done.actor.0.finFsm.Late' $$,
  $$ values (0) $$,
  'the parent''s queue gets nothing from the discarded result (#533)'
);

-- The completion wins: no cancel is announced for a worker that has finished.
select fsm_core.finish_async_operation_event_v2(
  'completed', 'fin533_v1_i_work_t', 3::bigint,
  'internalAsyncOperation', 'v1', 'xstate.done.actor.0.finFsm.Quick', 'xstate.invoke', '{}'::jsonb, 0,
  NULL, '0.finFsm.Quick', now(), 1, now(), 'succeeded', '{}'::jsonb, NULL);
select results_eq(
  $$ select (r->>'archive_result')::boolean, r->>'status', (r->>'cancel_notified')::boolean
     from fsm_core.finish_async_operation_event_v2('cancelled', 'fin533_v1_i_work_t', 3::bigint) r $$,
  $$ values (false, 'discarded'::text, false) $$,
  'a cancel after the result was archived is discarded and announces nothing (#533)'
);
select results_eq(
  $$ select async_operation_queue_msg_id, event_name, event_status
     from fsm_core.fsm_async_operation_queue_event_logs
     where async_operation_queue_name = 'fin533_v1_i_work_t'
     order by async_operation_queue_msg_id, event_status $$,
  $$ values (1::bigint, 'xstate.done.actor.0.finFsm.Working'::text, 'succeeded'::text),
            (2::bigint, 'cancel'::text, 'canceled'::text),
            (2::bigint, 'xstate.done.actor.0.finFsm.Late'::text, 'discarded'::text),
            (3::bigint, 'cancel'::text, 'discarded'::text),
            (3::bigint, 'xstate.done.actor.0.finFsm.Quick'::text, 'succeeded'::text) $$,
  'each call logs one row; the one that lost the race is logged discarded (#533)'
);

-- The cancel path's edge cases, moved from the dropped
-- cancel_event_for_fsm_async_operation_type_worker_v2's tests (#533).
select hasnt_function('fsm_core', 'cancel_event_for_fsm_async_operation_type_worker_v2',
  'cancel_event_for_fsm_async_operation_type_worker_v2 is dropped: stop_invoked_async_operation_v2 calls finish_async_operation_event_v2 (#533)');
select pgmq.create(queue_name := 'cancelQ2');
select results_eq(
  $$ select (r->>'archive_result')::boolean, r->>'status', (r->>'cancel_notified')::boolean
     from fsm_core.finish_async_operation_event_v2('cancelled', 'cancelQ2', 999::bigint) r $$,
  $$ values (false, 'discarded'::text, false) $$,
  'cancelling a message id that is not on the queue reports archive_result=false, no exception, no announcement'
);
select throws_ok(
  $$ select fsm_core.finish_async_operation_event_v2('cancelled', 'neverCreatedQueue', 1::bigint) $$,
  '42P01',
  'relation "pgmq.q_nevercreatedqueue" does not exist',
  'cancelling on a queue that was never created raises the raw pgmq relation-not-found error (not wrapped)'
);
-- #512: a real actor queue name of 37 characters made the old notify channel
-- ('fsm_async_operation_worker_' || name) 64 bytes, over PostgreSQL's limit.
select pgmq.create(queue_name := 'creditCheck_v01_i_verifyCredentials_t');
select pgmq.send(queue_name := 'creditCheck_v01_i_verifyCredentials_t', msg := '{"foo": "bar"}'::jsonb);
select results_eq(
  $$ select (r->>'archive_result')::boolean, (r->>'cancel_notified')::boolean
     from fsm_core.finish_async_operation_event_v2('cancelled', 'creditCheck_v01_i_verifyCredentials_t', 1::bigint) r $$,
  $$ values (true, true) $$,
  'cancelling on a queue name of 37+ characters works and is announced on the one fixed channel (#512)'
);

select * from finish();
rollback;
