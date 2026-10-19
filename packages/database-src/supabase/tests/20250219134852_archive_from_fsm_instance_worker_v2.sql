begin;
select plan(42);

select has_function('fsm_core', 'start_async_operation_for_worker_v2',
  ARRAY['text', 'text', 'jsonb', 'text', 'text', 'text', 'text', 'uuid', 'text', 'text'],
  'start_async_operation_for_worker_v2(...) exists (#526)');
select has_function('fsm_core', 'start_child_fsm_v2',
  ARRAY['text', 'text', 'jsonb', 'text', 'text', 'uuid'],
  'start_child_fsm_v2(...) exists (#526)');
select has_function('fsm_core', 'start_invoked_async_operation_v2',
  ARRAY['text', 'text', 'jsonb', 'text', 'text', 'text', 'text', 'uuid', 'text', 'text'],
  'start_invoked_async_operation_v2(...) exists (#526)');
select hasnt_function('fsm_core', 'send_event_to_queue_from_fsm_instance_id_v2',
  'the old dispatcher name is gone (#526)');
select hasnt_function('fsm_core', 'create_async_op_queue_and_send_event_from_fsm_instance_id_v2',
  'the old async operation name is gone (#526)');
select has_function('fsm_core', 'archive_event_from_fsm_type_worker_v2',
  ARRAY['text', 'bigint', 'jsonb', 'jsonb', 'jsonb', 'jsonb', 'jsonb', 'jsonb', 'jsonb', 'jsonb', 'jsonb', 'jsonb', 'jsonb', 'jsonb', 'jsonb'],
  'archive_event_from_fsm_type_worker_v2(...) exists, with raised_events, processed_internal_event (#519) and the error to save (#520)');

delete from fsm_core.fsm_async_operation_queue_event_logs where async_operation_queue_name like 'pFsm_v1_%';
delete from fsm_core.fsm_instance where fsm_name = 'srcFsm' and fsm_version = 'v1';
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version)
values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid, 'srcFsm', 'v1');

create temp table start526_async as
select fsm_core.start_async_operation_for_worker_v2(
  invoke_id := 'someId', src := 'childOp', input := '{"x": 1}'::jsonb, action_type := 'invoke',
  async_operation_type := 'internalAsyncOperation', async_operation_version := 'v1', async_operation_language := 'typescript',
  parent_fsm_instance_id := 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid,
  parent_fsm_name := 'pFsm', parent_fsm_version := 'v1') r;
select results_eq(
  $$ select r->>'invoke_id', r->>'src', r->>'async_operation_type', r->>'queue_id',
            (r->>'queue_msg_id')::bigint = (r->'queue_data'->>'queueMsgId')::bigint,
            r ? 'queue_event_log_id'
     from start526_async $$,
  $$ values ('someId'::text, 'childOp'::text, 'internalAsyncOperation'::text, 'pFsm_v1_i_childOp_t'::text, true, true) $$,
  'start_async_operation_for_worker_v2 returns the invoke''s entry, its queue named by compute_async_operation_queue_name_v2 (#526)'
);
select results_eq(
  $$ select m.message->'eventData'->>'eventType', m.message->>'sendToParentQueueId',
            m.message->>'sendToParentQueueIdEventName', m.message->'eventData'->'eventPayload'
     from pgmq.read('pFsm_v1_i_childOp_t', 0, 1) m $$,
  $$ values ('someId'::text, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::text, 'someId'::text, '{"x": 1}'::jsonb) $$,
  'the first start creates the async operation''s queue; the message keeps the reply-to the gateway answers on'
);
select lives_ok(
  $$ select fsm_core.start_async_operation_for_worker_v2('someId2', 'childOp', '{}'::jsonb, 'invoke',
       'internalAsyncOperation', 'v1', 'typescript', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid, 'pFsm', 'v1') $$,
  'a second start reuses the existing queue'
);
select throws_ok(
  $$ select fsm_core.start_async_operation_for_worker_v2('id', 'src', '{}'::jsonb, 'invoke',
       'unsupportedType', 'v1', 'typescript', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid, 'p', 'v1') $$,
  'P0001',
  'start_async_operation_for_worker_v2: unsupported async operation type: unsupportedType',
  'an unsupported async operation type raises (validated here, before delegating naming to compute_async_operation_queue_name_v2)'
);

-- start_child_fsm_v2 creates the child as a real instance (#523; it used to
-- log against an id it never inserted, a foreign-key failure), so an unknown
-- child FSM is reported by name.
select throws_ok(
  $$ select fsm_core.start_child_fsm_v2('someId', 'childName', '{"x": 1}'::jsonb, 'childName', 'v1',
       'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid) $$,
  'P0001',
  'FSM with name childName and version v1 not found in fsm_core.fsm_json',
  'invoking a child FSM that is not loaded raises a not-found error, not a foreign-key failure (#523)'
);

select throws_ok(
  $$ select fsm_core.start_invoked_async_operation_v2('id', 'src', '{}'::jsonb, 'invoke',
       'unsupportedFsmType', 'v1', 'typescript', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid, 'p', 'v1') $$,
  'P0001',
  'start_invoked_async_operation_v2: unsupported async operation type: unsupportedFsmType',
  'start_invoked_async_operation_v2 rejects an unrecognized async operation type'
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
       '"active"'::jsonb, '{"foo": "bar"}'::jsonb, '{"ctx": 1}'::jsonb, '{"xs": 1}'::jsonb) $$,
  $$ values ('{
       "parent_notify_result": null, "added_async_operation_queue_data": [], "added_schedule_queue_data": [],
       "internal_event_queue": [], "internal_event_count": 0,
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
  $$ select (fsm_core.archive_event_from_fsm_type_worker_v2(
       'ffffffff-ffff-ffff-ffff-ffffffffffff', 2::bigint,
       NULL, NULL, NULL, NULL, NULL, NULL,
       '"done"'::jsonb, '{"final": true}'::jsonb, '{"ctx": 1}'::jsonb, '{"xs": 1}'::jsonb
     ))->'parent_notify_result' $$,
  $$ values ('null'::jsonb) $$,
  'an instance with no parent notifies nobody when it finishes (#523)'
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
       '[{"invoke_id": "a", "src": "work", "queue_id": "archTotals_v1_i_work_t", "queue_msg_id": 1},
         {"invoke_id": "b", "src": "work", "queue_id": "archTotals_v1_i_work_t", "queue_msg_id": 2}]'::jsonb,
       '"active"'::jsonb, '{"s": 1}'::jsonb, '{"ctx": 1}'::jsonb, '{"xs": 1}'::jsonb) r $$,
  $$ values (
       '[{"invoke_id": "b", "src": "work", "queue_id": "archTotals_v1_i_work_t", "queue_msg_id": 2}]'::jsonb,
       '[{"schedule_queue_name": "timer", "event": {"send_event_name_to_parent_queue_id": "t"}}]'::jsonb) $$,
  'outstanding invokes and scheduled events this macrostep keeps stay in the new totals (#495)'
);
select results_eq(
  $$ select total_async_operation_queue_data, total_schedule_queue_data
     from fsm_core.fsm_instance where id = '22223333-4444-5555-6666-777788889999'::uuid $$,
  $$ values (
       '[{"invoke_id": "b", "src": "work", "queue_id": "archTotals_v1_i_work_t", "queue_msg_id": 2}]'::jsonb,
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
  '"active"'::jsonb, '{"a": "x"}'::jsonb, '{}'::jsonb, '{}'::jsonb) r;
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
  '"active"'::jsonb, '{"b": "y"}'::jsonb, '{}'::jsonb, '{}'::jsonb) r;
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
       '"active"'::jsonb, '{"c": "z"}'::jsonb, '{}'::jsonb, '{}'::jsonb) r $$,
  $$ values ('[]'::jsonb) $$,
  'processing the scheduled event itself drops its entry (#516)'
);

-- #523: invoking a child FSM creates a real child instance with its parent
-- recorded, and the child finishing tells the parent as
-- xstate.done.actor.<invoke id> / xstate.error.actor.<invoke id>.
delete from fsm_core.fsm_transitions where fsm_name = 'chChild' and fsm_version = 'v1';
delete from fsm_core.fsm_json where fsm_name = 'chChild' and fsm_version = 'v1';
insert into fsm_core.fsm_json (fsm_name, fsm_version, fsm_json) values ('chChild', 'v1', '{"id": "chChild"}'::jsonb);
insert into fsm_core.fsm_transitions (source, computed_sanitized_source_ltree, event_type, fsm_name, fsm_version)
values ('#chChild', 'chChild', 'NEXT', 'chChild', 'v1');
delete from fsm_core.fsm_instance where fsm_name = 'chParent' and fsm_version = 'v1';
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version)
values ('44445555-6666-7777-8888-999900001111'::uuid, 'chParent', 'v1');
select pgmq.create(queue_name := '44445555-6666-7777-8888-999900001111');

create temp table ch523_invoked as
select fsm_core.start_invoked_async_operation_v2(
  invoke_id := '0.chParent.Invoking', src := 'chChild', input := '{"n": 1}'::jsonb,
  action_type := 'entry', async_operation_type := 'fsm', async_operation_version := 'v1', async_operation_language := 'typescript',
  parent_fsm_instance_id := '44445555-6666-7777-8888-999900001111'::uuid,
  parent_fsm_name := 'chParent', parent_fsm_version := 'v1') r;

select results_eq(
  $$ select fi.parent_fsm_instance_id, fi.parent_invoke_id, fi.fsm_instance_context
     from fsm_core.fsm_instance fi, ch523_invoked
     where fi.id = (ch523_invoked.r->>'queue_id')::uuid $$,
  $$ values ('44445555-6666-7777-8888-999900001111'::uuid, '0.chParent.Invoking'::text, '{"n": 1}'::jsonb) $$,
  'invoking a child FSM creates its fsm_instance row with the parent and the invoke id, and the invoke input as context (#523)'
);
select results_eq(
  $$ select (select count(*)::int from fsm_core.fsm_instance_and_fsm_workerlet w where w.fsm_instance_id = (r->>'queue_id')::uuid),
            (select (m.message->'eventData'->>'eventType') from pgmq.read(r->>'queue_id', 0, 1) m)
     from ch523_invoked $$,
  $$ values (1, 'initialTransition_event'::text) $$,
  'the child is queued for an fsmlet and starts with initialTransition_event'
);
select results_eq(
  $$ select r->>'invoke_id', r->>'src', r->>'async_operation_type',
            (r->>'queue_msg_id')::bigint = (r->'queue_data'->>'queueMsgId')::bigint, r ? 'queue_event_log_id'
     from ch523_invoked $$,
  $$ values ('0.chParent.Invoking'::text, 'chChild'::text, 'fsm'::text, true, true) $$,
  'a child FSM''s entry has the same shape as a worker async operation''s (#526)'
);

-- The child finishing: done, then (another child) error.
select pgmq.send(queue_name := (select r->>'queue_id' from ch523_invoked), msg := '{"finish": 1}'::jsonb);
select results_eq(
  $$ select (fsm_core.archive_event_from_fsm_type_worker_v2(
       (select r->>'queue_id' from ch523_invoked), 2::bigint,
       NULL, NULL, NULL, NULL, NULL, NULL,
       '"done"'::jsonb, '"Finished"'::jsonb, '{"n": 2}'::jsonb, '{}'::jsonb))->'parent_notify_result'->'queue_data'->'eventData' $$,
  $$ values ('{"eventType": "xstate.done.actor.0.chParent.Invoking", "eventPayload": {"n": 2}, "actionType": "childFsm_completed"}'::jsonb) $$,
  'a child reaching done sends xstate.done.actor.<invoke id> to its parent, with its context (#523)'
);
select results_eq(
  $$ select (m.message->'eventData'->>'eventType') from pgmq.read('44445555-6666-7777-8888-999900001111', 0, 10) m $$,
  $$ values ('xstate.done.actor.0.chParent.Invoking'::text) $$,
  'the event is on the parent''s queue'
);

insert into fsm_core.fsm_instance (id, fsm_name, fsm_version, parent_fsm_instance_id, parent_invoke_id)
values ('55556666-7777-8888-9999-000011112222'::uuid, 'chChild', 'v1', '44445555-6666-7777-8888-999900001111'::uuid, '1.chParent.Other');
select pgmq.create(queue_name := '55556666-7777-8888-9999-000011112222');
select pgmq.send(queue_name := '55556666-7777-8888-9999-000011112222', msg := '{"fail": 1}'::jsonb);
select results_eq(
  $$ select (fsm_core.archive_event_from_fsm_type_worker_v2(
       '55556666-7777-8888-9999-000011112222', 1::bigint,
       NULL, NULL, NULL, NULL, NULL, NULL,
       '"error"'::jsonb, '"Failed"'::jsonb, '{}'::jsonb, '{}'::jsonb))->'parent_notify_result'->'queue_data'->'eventData'->>'eventType' $$,
  $$ values ('xstate.error.actor.1.chParent.Other'::text) $$,
  'a child ending in error sends xstate.error.actor.<invoke id> (#523)'
);

-- #526: a macrostep that starts a child FSM and a worker async operation keeps both
-- entries next to the ones already there. The child's result had no
-- queue_data, so step 6 appended NULL and wiped the whole list.
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version)
values ('66667777-8888-9999-0000-111122223333'::uuid, 'chParent', 'v1');
select pgmq.create(queue_name := '66667777-8888-9999-0000-111122223333');
select pgmq.send(queue_name := '66667777-8888-9999-0000-111122223333', msg := '{"enter": 1}'::jsonb);
select pgmq.send(queue_name := '66667777-8888-9999-0000-111122223333', msg := '{"exit": 1}'::jsonb);

create temp table both526 as
select fsm_core.archive_event_from_fsm_type_worker_v2(
  '66667777-8888-9999-0000-111122223333', 1::bigint,
  NULL, NULL, NULL,
  '[{"id": "0.chParent.Both", "src": "chChild", "input": {"n": 3}, "action_type": "entry",
     "asyncOperationType": "fsm", "asyncOperationVersion": "v1"},
    {"id": "0.chParent.Both", "src": "work526", "input": {}, "action_type": "entry",
     "asyncOperationType": "internalAsyncOperation", "asyncOperationVersion": "v1",
     "asyncOperationLanguage": "typescript", "parentFsmName": "chParent", "parentFsmVersion": "v1"}]'::jsonb,
  NULL,
  '[{"invoke_id": "0.chParent.Earlier", "src": "older", "async_operation_type": "internalAsyncOperation",
     "queue_id": "chParent_v1_i_older_t", "queue_msg_id": 9}]'::jsonb,
  '"active"'::jsonb, '{"s": 1}'::jsonb, '{}'::jsonb, '{}'::jsonb) r;

select results_eq(
  $$ select jsonb_path_query_array(total_async_operation_queue_data, '$[*].src'),
            jsonb_path_query_array(total_async_operation_queue_data, '$[*].async_operation_type')
     from fsm_core.fsm_instance where id = '66667777-8888-9999-0000-111122223333'::uuid $$,
  $$ values ('["older", "chChild", "work526"]'::jsonb,
             '["internalAsyncOperation", "fsm", "internalAsyncOperation"]'::jsonb) $$,
  'starting a child FSM and a worker async operation keeps the earlier entry and adds both (#526)'
);

-- The invoking state exits: only the child's invoke is stopped here.
select results_eq(
  $$ select jsonb_path_query_array(r->'new_total_async_operation_queue_data', '$[*].src'),
            jsonb_path_query_array(r->'confirmed_removed_async_operation_queue_data_success', '$[*].src')
     from fsm_core.archive_event_from_fsm_type_worker_v2(
       '66667777-8888-9999-0000-111122223333', 2::bigint,
       NULL, '[{"id": "0.chParent.Both", "src": "chChild"}]'::jsonb, NULL, NULL, NULL,
       (select total_async_operation_queue_data from fsm_core.fsm_instance where id = '66667777-8888-9999-0000-111122223333'::uuid),
       '"active"'::jsonb, '{"s": 2}'::jsonb, '{}'::jsonb, '{}'::jsonb) r $$,
  $$ values ('["older", "work526"]'::jsonb, '["chChild"]'::jsonb) $$,
  'on exit the entry is found by invoke_id and src, and the others stay (#526)'
);
select is(
  (select count(*)::int from pgmq.read(
     (select r->'new_total_async_operation_queue_data'->1->>'queue_id' from both526), 0, 10)),
  0,
  'the child''s queued start event is cancelled with the entry''s queue_id and queue_msg_id'
);

-- SPEC-010 (b), #519: the internal event queue. An event from pgmq raises two
-- events; the first is then processed from the internal queue.
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version, fsm_type)
values ('88889999-aaaa-bbbb-cccc-dddd00001111'::uuid, 'iqFsm', 'v1', 'fsm');
select pgmq.create(queue_name := '88889999-aaaa-bbbb-cccc-dddd00001111');
select pgmq.send(queue_name := '88889999-aaaa-bbbb-cccc-dddd00001111', msg := '{"external": 1}'::jsonb);

select fsm_core.archive_event_from_fsm_type_worker_v2(
  '88889999-aaaa-bbbb-cccc-dddd00001111', 1::bigint, NULL, NULL, NULL, NULL, NULL, NULL,
  '"active"'::jsonb, '{"s": 1}'::jsonb, '{}'::jsonb, '{}'::jsonb,
  '[{"eventType": "xstate.done.state.e1"}, {"eventType": "xstate.done.state.e2"}]'::jsonb, NULL);
select results_eq(
  $$ select internal_event_queue, internal_event_count, fsm_instance_state
     from fsm_core.fsm_instance where id = '88889999-aaaa-bbbb-cccc-dddd00001111'::uuid $$,
  $$ values ('[{"eventType": "xstate.done.state.e1"}, {"eventType": "xstate.done.state.e2"}]'::jsonb, 0, '{"s": 1}'::jsonb) $$,
  'the archive appends raised_events to the internal event queue with the state it saves (#519)'
);
select results_eq(
  $$ select array_agg(event_name order by event_name), array_agg(distinct event_source), bool_and(fsm_instance_queue_msg_id is null)
     from fsm_core.fsm_instance_queue_event_logs where fsm_instance_id = '88889999-aaaa-bbbb-cccc-dddd00001111'::uuid and event_source = 'internal' $$,
  $$ values (ARRAY['xstate.done.state.e1', 'xstate.done.state.e2'], ARRAY['internal'], true) $$,
  'each raised event is logged with event_source = internal (#519)'
);

-- A message that arrived meanwhile stays on pgmq while internal events go first.
select pgmq.send(queue_name := '88889999-aaaa-bbbb-cccc-dddd00001111', msg := '{"external": 2}'::jsonb);
select results_eq(
  $$ select r->'internal_event_queue', (r->>'internal_event_count')::int
     from fsm_core.archive_event_from_fsm_type_worker_v2(
       '88889999-aaaa-bbbb-cccc-dddd00001111', NULL::bigint, NULL, NULL, NULL, NULL, NULL, NULL,
       '"active"'::jsonb, '{"s": 2}'::jsonb, '{}'::jsonb, '{}'::jsonb,
       '[{"eventType": "xstate.done.state.e3"}]'::jsonb, '{"eventType": "xstate.done.state.e1"}'::jsonb) r $$,
  $$ values ('[{"eventType": "xstate.done.state.e2"}, {"eventType": "xstate.done.state.e3"}]'::jsonb, 1) $$,
  'processing an internal event removes the head of the queue and counts it (#519)'
);
select is(
  (select count(*)::int from pgmq.read('88889999-aaaa-bbbb-cccc-dddd00001111', 0, 10)),
  1,
  'an internal event archives no pgmq message: the waiting one is still there'
);
select throws_like(
  $$ select fsm_core.archive_event_from_fsm_type_worker_v2(
       '88889999-aaaa-bbbb-cccc-dddd00001111', NULL::bigint, NULL, NULL, NULL, NULL, NULL, NULL,
       '"active"'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
       '[]'::jsonb, '{"eventType": "xstate.done.state.e3"}'::jsonb) $$,
  'internal event % is not the head of instance %',
  'an internal event that isn''t the head of the queue is refused'
);

-- A failing archive saves nothing: the raised events and the state go together.
select throws_ok(
  $$ select fsm_core.archive_event_from_fsm_type_worker_v2(
       '88889999-aaaa-bbbb-cccc-dddd00001111', NULL::bigint, NULL, NULL, NULL,
       '[{"id": "bad", "src": "x", "asyncOperationType": "unsupported"}]'::jsonb, NULL, NULL,
       '"active"'::jsonb, '{"s": 3}'::jsonb, '{}'::jsonb, '{}'::jsonb,
       '[{"eventType": "xstate.done.state.lost"}]'::jsonb, '{"eventType": "xstate.done.state.e2"}'::jsonb) $$,
  'P0001'
);
select results_eq(
  $$ select internal_event_queue, internal_event_count, fsm_instance_state
     from fsm_core.fsm_instance where id = '88889999-aaaa-bbbb-cccc-dddd00001111'::uuid $$,
  $$ values ('[{"eventType": "xstate.done.state.e2"}, {"eventType": "xstate.done.state.e3"}]'::jsonb, 1, '{"s": 2}'::jsonb) $$,
  'a failed archive leaves both the internal queue and the state unchanged (#519)'
);

-- An event from pgmq resets the count; done clears the queue, raised events included.
select results_eq(
  $$ select r->'internal_event_queue', (r->>'internal_event_count')::int
     from fsm_core.archive_event_from_fsm_type_worker_v2(
       '88889999-aaaa-bbbb-cccc-dddd00001111', 2::bigint, NULL, NULL, NULL, NULL, NULL, NULL,
       '"done"'::jsonb, '{"s": 4}'::jsonb, '{}'::jsonb, '{}'::jsonb,
       '[{"eventType": "xstate.done.state.iqFsm"}]'::jsonb, NULL) r $$,
  $$ values ('[]'::jsonb, 0) $$,
  'an instance that is done keeps no internal events, as XState''s macrostep stops (#519)'
);

-- The cycle cap: the 101st internal event in a row sets the instance to error.
update fsm_core.fsm_instance
set internal_event_queue = '[{"eventType": "xstate.done.state.loop"}]'::jsonb, internal_event_count = 100,
    fsm_instance_status = '"active"'::jsonb
where id = '88889999-aaaa-bbbb-cccc-dddd00001111'::uuid;
select fsm_core.archive_event_from_fsm_type_worker_v2(
  '88889999-aaaa-bbbb-cccc-dddd00001111', NULL::bigint, NULL, NULL, NULL, NULL, NULL, NULL,
  '"active"'::jsonb, '{"s": 5}'::jsonb, '{}'::jsonb, '{}'::jsonb,
  '[{"eventType": "xstate.done.state.loop"}]'::jsonb, '{"eventType": "xstate.done.state.loop"}'::jsonb);
select results_eq(
  $$ select fsm_instance_status, fsm_instance_error->>'message' like 'Infinite loop: more than 100 internal events in a row%', internal_event_queue
     from fsm_core.fsm_instance where id = '88889999-aaaa-bbbb-cccc-dddd00001111'::uuid $$,
  $$ values ('"error"'::jsonb, true, '[]'::jsonb) $$,
  'past the cycle cap the status becomes error with an infinite-loop message (#519)'
);

-- #520: an unhandled xstate.error.actor.* event: the worker saves status error
-- with the event's error, and nothing more is processed.
update fsm_core.fsm_instance
set fsm_instance_status = '"active"'::jsonb, fsm_instance_error = NULL,
    internal_event_queue = '[{"eventType": "xstate.done.state.pending"}]'::jsonb, internal_event_count = 0
where id = '88889999-aaaa-bbbb-cccc-dddd00001111'::uuid;
select pgmq.send(queue_name := '88889999-aaaa-bbbb-cccc-dddd00001111', msg := '{"actorError": 1}'::jsonb);
select fsm_core.archive_event_from_fsm_type_worker_v2(
  '88889999-aaaa-bbbb-cccc-dddd00001111', (select max(msg_id) from pgmq.read('88889999-aaaa-bbbb-cccc-dddd00001111', 0, 10)), NULL, NULL, NULL, NULL, NULL, NULL,
  '"error"'::jsonb, '{"s": 6}'::jsonb, '{}'::jsonb, '{}'::jsonb,
  '[]'::jsonb, NULL, '{"message": "boom"}'::jsonb);
select results_eq(
  $$ select fsm_instance_status, fsm_instance_error, internal_event_queue
     from fsm_core.fsm_instance where id = '88889999-aaaa-bbbb-cccc-dddd00001111'::uuid $$,
  $$ values ('"error"'::jsonb, '{"message": "boom"}'::jsonb, '[]'::jsonb) $$,
  'status error saves the error passed and clears the internal queue (#520)'
);

select * from finish();
rollback;
