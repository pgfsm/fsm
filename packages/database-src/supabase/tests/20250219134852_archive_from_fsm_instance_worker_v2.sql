begin;
select plan(20);

select has_function('fsm_core', 'create_async_op_queue_and_send_event_from_fsm_instance_id_v2',
  ARRAY['text', 'jsonb', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'uuid'],
  'create_async_op_queue_and_send_event_from_fsm_instance_id_v2(...) exists');
select has_function('fsm_core', 'create_fsm_queue_and_send_event_from_fsm_instance_id_v2',
  ARRAY['text', 'jsonb', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'uuid'],
  'create_fsm_queue_and_send_event_from_fsm_instance_id_v2(...) exists');
select has_function('fsm_core', 'send_event_to_queue_from_fsm_instance_id_v2',
  ARRAY['text', 'jsonb', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'uuid'],
  'send_event_to_queue_from_fsm_instance_id_v2(...) exists');
select has_function('fsm_core', 'archive_event_from_fsm_type_worker_v2',
  ARRAY['text', 'bigint', 'jsonb', 'jsonb', 'jsonb', 'jsonb', 'jsonb', 'jsonb', 'jsonb', 'jsonb', 'jsonb', 'jsonb', 'uuid', 'text', 'text'],
  'archive_event_from_fsm_type_worker_v2(...) exists');

delete from fsm_core.fsm_async_operation_queue_event_logs where async_operation_queue_name like 'pFsm_v1_%';
delete from fsm_core.fsm_instance where fsm_name = 'srcFsm' and fsm_version = 'v1';
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version)
values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid, 'srcFsm', 'v1');

select results_eq(
  $$ select (r->>'start_queue_worker')::boolean, (r->'queue_data'->>'queueId')
     from fsm_core.create_async_op_queue_and_send_event_from_fsm_instance_id_v2(
       'evt1', '{"x": 1}'::jsonb, 'someId', 'invoke', 'someSrc', 'childOp', 'internalAsyncOperation', 'v1',
       'pFsm', 'v1', 'typescript', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid) r $$,
  $$ values (true, 'pFsm_v1_i_childOp_t'::text) $$,
  'the first call for a not-yet-existing async-operation queue creates it (start_queue_worker=true), naming delegated to compute_async_operation_queue_name_v2'
);
select results_eq(
  $$ select (r->>'start_queue_worker')::boolean
     from fsm_core.create_async_op_queue_and_send_event_from_fsm_instance_id_v2(
       'evt2', '{"x": 2}'::jsonb, 'someId2', 'invoke', 'someSrc', 'childOp', 'internalAsyncOperation', 'v1',
       'pFsm', 'v1', 'typescript', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid) r $$,
  $$ values (false) $$,
  'a second call for the same async-operation queue reuses it (start_queue_worker=false)'
);
select throws_ok(
  $$ select fsm_core.create_async_op_queue_and_send_event_from_fsm_instance_id_v2(
       'evt', '{}'::jsonb, 'id', 'invoke', 'src', 'x', 'unsupportedType', 'v1', 'p', 'v1',
       'typescript', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid) $$,
  'P0001',
  'create_async_op_queue_and_send_event_from_fsm_instance_id_v2: unsupported fsmType: unsupportedType',
  'an unsupported fsmType still raises (validated here, before delegating naming to compute_async_operation_queue_name_v2)'
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
       'typescript', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid) $$,
  'P0001',
  'Unsupported fsmType: unsupportedFsmType',
  'send_event_to_queue_from_fsm_instance_id_v2 rejects an unrecognized fsmType'
);

-- Simplest case for the macro archive/save function: no schedule/async-operation
-- queue churn, non-terminal status (no parent notify), just update instance state
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
       "parent_notify_result": null, "added_async_operation_queue_data": [], "added_schedule_queue_data": [],
       "new_total_async_operation_queue_data": [], "old_total_async_operation_queue_data": null,
       "new_total_schedule_queue_data": [], "old_total_schedule_queue_data": null,
       "not_confirmed_removed_async_operation_queue_data": [], "not_confirmed_removed_schedule_queue_data": [],
       "confirmed_removed_async_operation_queue_data_failed": [], "confirmed_removed_async_operation_queue_data_success": [],
       "confirmed_removed_schedule_queue_data_failed": [], "confirmed_removed_schedule_queue_data_success": []
     }'::jsonb) $$,
  'with no schedule/async-operation churn and a non-terminal status, the result is all empty arrays and no parent notify'
);
select results_eq(
  $$ select fsm_instance_status, fsm_instance_state, fsm_instance_context, fsm_instance_xstate_state,
            total_schedule_queue_data, total_async_operation_queue_data
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

-- #495: an instance with outstanding actor invokes and scheduled events. This
-- macrostep removes one invoke (its actor's queue message is cancelled) and
-- keeps the other invoke and the scheduled event in the instance's totals.
-- These totals are jsonb arrays; array_append on them used to fail every
-- macrostep that had any outstanding invoke or scheduled event.
delete from fsm_core.fsm_instance where fsm_name = 'archTotalsFsm' and fsm_version = 'v1';
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version)
values ('22223333-4444-5555-6666-777788889999'::uuid, 'archTotalsFsm', 'v1');
select pgmq.create(queue_name := '22223333-4444-5555-6666-777788889999');
select pgmq.send(queue_name := '22223333-4444-5555-6666-777788889999', msg := '{"result": 1}'::jsonb);
select pgmq.create(queue_name := 'archTotals_v1_i_work_t');
select pgmq.send(queue_name := 'archTotals_v1_i_work_t', msg := '{"invoke": "a"}'::jsonb);

select results_eq(
  $$ select r->'new_total_async_operation_queue_data', r->'new_total_schedule_queue_data'
     from fsm_core.archive_event_from_fsm_type_worker_v2(
       '22223333-4444-5555-6666-777788889999', 1::bigint,
       NULL,
       '[{"id": "a", "src": "work"}]'::jsonb,
       NULL, NULL,
       '[{"schedule_queue_name": "timer", "event": {"send_event_name_to_parent_queue_id": "t"}}]'::jsonb,
       '[{"queueId": "archTotals_v1_i_work_t", "queueMsgId": 1, "queueFnName": "work", "sendToParentQueueIdEventName": "a"},
         {"queueId": "archTotals_v1_i_work_t", "queueMsgId": 2, "queueFnName": "work", "sendToParentQueueIdEventName": "b"}]'::jsonb,
       '"active"'::jsonb, '{"s": 1}'::jsonb, '{"ctx": 1}'::jsonb, '{"xs": 1}'::jsonb,
       NULL, NULL, NULL) r $$,
  $$ values (
       '[{"queueId": "archTotals_v1_i_work_t", "queueMsgId": 2, "queueFnName": "work", "sendToParentQueueIdEventName": "b"}]'::jsonb,
       '[{"schedule_queue_name": "timer", "event": {"send_event_name_to_parent_queue_id": "t"}}]'::jsonb) $$,
  'outstanding invokes and scheduled events this macrostep keeps stay in the new totals (#495)'
);
select results_eq(
  $$ select total_async_operation_queue_data, total_schedule_queue_data
     from fsm_core.fsm_instance where id = '22223333-4444-5555-6666-777788889999'::uuid $$,
  $$ values (
       '[{"queueId": "archTotals_v1_i_work_t", "queueMsgId": 2, "queueFnName": "work", "sendToParentQueueIdEventName": "b"}]'::jsonb,
       '[{"schedule_queue_name": "timer", "event": {"send_event_name_to_parent_queue_id": "t"}}]'::jsonb) $$,
  'the instance row keeps the remaining invoke and scheduled event (#495)'
);
select is(
  (select count(*)::int from pgmq.read('archTotals_v1_i_work_t', 0, 10)),
  0,
  'the removed invoke''s actor queue message is cancelled (#495)'
);

-- #516: an `after` timer. The worker asks the archive to schedule the event
-- by name (`id`) after `delay` ms; a cancel names that event; when the
-- scheduled message itself is processed, its entry is dropped.
delete from fsm_core.fsm_instance where fsm_name = 'archAfterFsm' and fsm_version = 'v1';
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version)
values ('33334444-5555-6666-7777-888899990000'::uuid, 'archAfterFsm', 'v1');
select pgmq.create(queue_name := '33334444-5555-6666-7777-888899990000');
select pgmq.send(queue_name := '33334444-5555-6666-7777-888899990000', msg := '{"enter": "a"}'::jsonb);

-- 1. Entering a state with after: { 60000 } schedules its event.
create temp table arch516_scheduled as
select r from fsm_core.archive_event_from_fsm_type_worker_v2(
  '33334444-5555-6666-7777-888899990000', 1::bigint,
  NULL, NULL,
  '[{"type": "xstate.raise", "id": "xstate.after.60000.m.a", "delay": 60000, "input": {"type": "xstate.after.60000.m.a"},
     "fsmType": "archAfterFsm", "fsmVersion": "v1", "action_type": "entry"}]'::jsonb,
  NULL, '[]'::jsonb, '[]'::jsonb,
  '"active"'::jsonb, '{"a": "x"}'::jsonb, '{}'::jsonb, '{}'::jsonb,
  NULL, NULL, NULL) r;
select results_eq(
  $$ select jsonb_path_query_array(r->'new_total_schedule_queue_data', '$[*].queue_data.eventData.eventType'),
            jsonb_path_query_array(r->'new_total_schedule_queue_data', '$[*].queue_data.queueMsgDelay')
     from arch516_scheduled $$,
  $$ values ('["xstate.after.60000.m.a"]'::jsonb, '[60]'::jsonb) $$,
  'an after timer is scheduled under its event name, its delay in seconds (#516)'
);
select is(
  (select count(*)::int from pgmq.read('33334444-5555-6666-7777-888899990000', 0, 10)),
  0,
  'the scheduled event is not visible yet (delayed)'
);

-- 2. Leaving the state first cancels it: the delayed message is archived.
select pgmq.send(queue_name := '33334444-5555-6666-7777-888899990000', msg := '{"leave": "a"}'::jsonb);
create temp table arch516_cancelled as
select r from fsm_core.archive_event_from_fsm_type_worker_v2(
  '33334444-5555-6666-7777-888899990000', 3::bigint,
  '[{"type": "xstate.cancel", "id": "xstate.after.60000.m.a"}]'::jsonb, NULL,
  NULL, NULL,
  (select r->'new_total_schedule_queue_data' from arch516_scheduled), '[]'::jsonb,
  '"active"'::jsonb, '{"b": "y"}'::jsonb, '{}'::jsonb, '{}'::jsonb,
  NULL, NULL, NULL) r;
select results_eq(
  $$ select r->'new_total_schedule_queue_data', jsonb_array_length(r->'confirmed_removed_schedule_queue_data_success')
     from arch516_cancelled $$,
  $$ values ('[]'::jsonb, 1) $$,
  'a cancel by event name removes the scheduled entry (#516)'
);
select is(
  (select queue_length::int from pgmq.metrics('33334444-5555-6666-7777-888899990000')),
  0,
  'the cancelled event''s delayed message is archived, so it never fires (#516)'
);

-- 3. A scheduled event that fires drops its own entry when it is processed.
select pgmq.send(queue_name := '33334444-5555-6666-7777-888899990000', msg := '{"enter": "a"}'::jsonb);
select results_eq(
  $$ select r->'new_total_schedule_queue_data'
     from fsm_core.archive_event_from_fsm_type_worker_v2(
       '33334444-5555-6666-7777-888899990000', 4::bigint,
       NULL, NULL, NULL, NULL,
       '[{"queue_data": {"eventData": {"eventType": "xstate.after.60000.m.a"}, "queueMsgId": 4}}]'::jsonb, '[]'::jsonb,
       '"active"'::jsonb, '{"c": "z"}'::jsonb, '{}'::jsonb, '{}'::jsonb,
       NULL, NULL, NULL) r $$,
  $$ values ('[]'::jsonb) $$,
  'processing the scheduled event itself drops its entry (#516)'
);

select * from finish();
rollback;
