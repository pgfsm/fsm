begin;
select plan(12);

select has_function('fsm_core', 'create_promise_queue_and_send_event_from_fsm_instance_id_v2',
  ARRAY['text', 'jsonb', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'uuid'],
  'create_promise_queue_and_send_event_from_fsm_instance_id_v2(...) exists');
select has_function('fsm_core', 'create_fsm_queue_and_send_event_from_fsm_instance_id_v2',
  ARRAY['text', 'jsonb', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'uuid'],
  'create_fsm_queue_and_send_event_from_fsm_instance_id_v2(...) exists');
select has_function('fsm_core', 'send_event_to_queue_from_fsm_instance_id_v2',
  ARRAY['text', 'jsonb', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'uuid'],
  'send_event_to_queue_from_fsm_instance_id_v2(...) exists');
select has_function('fsm_core', 'archive_event_from_fsm_type_worker_v2',
  ARRAY['text', 'bigint', 'jsonb', 'jsonb', 'jsonb', 'jsonb', 'jsonb', 'jsonb', 'jsonb', 'jsonb', 'jsonb', 'jsonb', 'uuid', 'text', 'text'],
  'archive_event_from_fsm_type_worker_v2(...) exists');

delete from fsm_core.fsm_promise_queue_event_logs where promise_queue_name like 'pFsm_v1_%';
delete from fsm_core.fsm_instance where fsm_name = 'srcFsm' and fsm_version = 'v1';
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version)
values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid, 'srcFsm', 'v1');

select results_eq(
  $$ select (r->>'start_queue_worker')::boolean, (r->'queue_data'->>'queueId')
     from fsm_core.create_promise_queue_and_send_event_from_fsm_instance_id_v2(
       'evt1', '{"x": 1}'::jsonb, 'someId', 'invoke', 'someSrc', 'childOp', 'promise', 'v1',
       'pFsm', 'v1', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid) r $$,
  $$ values (true, 'pFsm_v1_childOp'::text) $$,
  'the first call for a not-yet-existing promise queue creates it (start_queue_worker=true)'
);
select results_eq(
  $$ select (r->>'start_queue_worker')::boolean
     from fsm_core.create_promise_queue_and_send_event_from_fsm_instance_id_v2(
       'evt2', '{"x": 2}'::jsonb, 'someId2', 'invoke', 'someSrc', 'childOp', 'promise', 'v1',
       'pFsm', 'v1', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid) r $$,
  $$ values (false) $$,
  'a second call for the same promise queue reuses it (start_queue_worker=false)'
);
select throws_ok(
  $$ select fsm_core.create_promise_queue_and_send_event_from_fsm_instance_id_v2(
       'evt', '{}'::jsonb, 'id', 'invoke', 'src', 'x', 'unsupportedType', 'v1', 'p', 'v1',
       'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid) $$,
  'P0001',
  'create_promise_queue_and_send_event_from_fsm_instance_id_v2: unsupported fsmType: unsupportedType',
  'an unsupported fsmType raises'
);

-- Characterization test: create_fsm_queue_and_send_event_from_fsm_instance_id_v2
-- generates a brand-new child_instance_id via uuid_generate_v4() and immediately
-- tries to log an event against it in fsm_instance_queue_event_logs, whose
-- fsm_instance_id column has a foreign key to fsm_core.fsm_instance. Since that
-- freshly generated id was never inserted into fsm_instance, this always fails
-- with a foreign key violation as currently written. Filed as a bug (see
-- tracking issue) — documented here rather than silently papered over.
select throws_ok(
  $$ select fsm_core.create_fsm_queue_and_send_event_from_fsm_instance_id_v2(
       'childEvt', '{"x": 1}'::jsonb, 'someId', 'childFsm', 'someSrc', 'childName', 'childFsm', 'v1',
       'parentName', 'parentV1', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid) $$,
  '23503',
  'insert or update on table "fsm_instance_queue_event_logs" violates foreign key constraint "fsm_instance_queue_event_logs_fsm_instance_id_fkey"',
  'create_fsm_queue_and_send_event_from_fsm_instance_id_v2 always fails: it logs against a freshly-generated child_instance_id that was never inserted into fsm_instance (foreign key violation, likely a bug)'
);

select throws_ok(
  $$ select fsm_core.send_event_to_queue_from_fsm_instance_id_v2(
       'evt', '{}'::jsonb, 'id', 'invoke', 'src', 'x', 'unsupportedFsmType', 'v1', 'p', 'v1',
       'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid) $$,
  'P0001',
  'Unsupported fsmType: unsupportedFsmType',
  'send_event_to_queue_from_fsm_instance_id_v2 rejects an unrecognized fsmType'
);

-- Simplest case for the macro archive/save function: no schedule/promise queue
-- churn, non-terminal status (no parent notify), just update instance state
-- and archive the current queue message.
delete from fsm_core.fsm_instance where fsm_name = 'archMacroFsm' and fsm_version = 'v1';
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version)
values ('ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid, 'archMacroFsm', 'v1');
select pgmq.create(queue_name := 'ffffffff-ffff-ffff-ffff-ffffffffffff');
select pgmq.send(queue_name := 'ffffffff-ffff-ffff-ffff-ffffffffffff', msg := '{"foo": "bar"}'::jsonb);

select results_eq(
  $$ select fsm_core.archive_event_from_fsm_type_worker_v2(
       'ffffffff-ffff-ffff-ffff-ffffffffffff', 1::bigint,
       NULL, NULL, NULL, NULL, NULL, NULL,
       '"active"'::jsonb, '{"foo": "bar"}'::jsonb, '{"ctx": 1}'::jsonb, '{"xs": 1}'::jsonb,
       NULL, NULL, NULL) $$,
  $$ values ('{
       "parent_notify_result": null, "added_promise_queue_data": [], "added_schedule_queue_data": [],
       "new_total_promise_queue_data": [], "old_total_promise_queue_data": null,
       "new_total_schedule_queue_data": [], "old_total_schedule_queue_data": null,
       "not_confirmed_removed_promise_queue_data": [], "not_confirmed_removed_schedule_queue_data": [],
       "confirmed_removed_promise_queue_data_failed": [], "confirmed_removed_promise_queue_data_success": [],
       "confirmed_removed_schedule_queue_data_failed": [], "confirmed_removed_schedule_queue_data_success": []
     }'::jsonb) $$,
  'with no schedule/promise churn and a non-terminal status, the result is all empty arrays and no parent notify'
);
select results_eq(
  $$ select fsm_instance_status, fsm_instance_state, fsm_instance_context, fsm_instance_xstate_state,
            total_schedule_queue_data, total_promise_queue_data
     from fsm_core.fsm_instance where id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid $$,
  $$ values ('"active"'::jsonb, '{"foo": "bar"}'::jsonb, '{"ctx": 1}'::jsonb, '{"xs": 1}'::jsonb, '[]'::jsonb, '[]'::jsonb) $$,
  'the fsm_instance row is updated with the new status/state/context/xstate_state'
);

-- Terminal status + a real (non-system) parent queue triggers a parent notify.
delete from fsm_core.fsm_instance where fsm_name = 'archParentFsm' and fsm_version = 'v1';
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version)
values ('11112222-3333-4444-5555-666677778888'::uuid, 'archParentFsm', 'v1');
select pgmq.create(queue_name := '11112222-3333-4444-5555-666677778888');
select pgmq.send(queue_name := 'ffffffff-ffff-ffff-ffff-ffffffffffff', msg := '{"another": "msg"}'::jsonb);

select results_eq(
  $$ select ((fsm_core.archive_event_from_fsm_type_worker_v2(
       'ffffffff-ffff-ffff-ffff-ffffffffffff', 2::bigint,
       NULL, NULL, NULL, NULL, NULL, NULL,
       '"done"'::jsonb, '{"final": true}'::jsonb, '{"ctx": 1}'::jsonb, '{"xs": 1}'::jsonb,
       '11112222-3333-4444-5555-666677778888'::uuid, 'FSM', 'childDoneEvt'
     ))->'parent_notify_result'->'queue_data'->'eventData'->>'eventType') $$,
  $$ values ('childDoneEvt'::text) $$,
  'a terminal status with a real parent queue id sends a completion event to the parent'
);

select * from finish();
rollback;
