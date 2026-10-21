begin;
select plan(78);

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
       "discarded": false, "fsm_instance_status": "active",
       "terminal_stopped_async_operation_queue_data": [], "terminal_archived_msg_ids": [],
       "parent_notify_result": null, "added_async_operation_queue_data": [], "added_schedule_queue_data": [],
       "internal_event_queue": [], "internal_event_count": 0,
       "new_total_async_operation_queue_data": [], "old_total_async_operation_queue_data": [],
       "new_total_schedule_queue_data": [], "old_total_schedule_queue_data": [],
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
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version, total_schedule_queue_data, total_async_operation_queue_data)
values ('22223333-4444-5555-6666-777788889999'::uuid, 'archTotalsFsm', 'v1',
  '[{"schedule_queue_name": "timer", "event": {"send_event_name_to_parent_queue_id": "t"}}]'::jsonb,
  '[{"invoke_id": "a", "src": "work", "queue_id": "archTotals_v1_i_work_t", "queue_msg_id": 1},
    {"invoke_id": "b", "src": "work", "queue_id": "archTotals_v1_i_work_t", "queue_msg_id": 2}]'::jsonb);
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
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version, total_async_operation_queue_data)
values ('66667777-8888-9999-0000-111122223333'::uuid, 'chParent', 'v1',
  '[{"invoke_id": "0.chParent.Earlier", "src": "older", "async_operation_type": "internalAsyncOperation",
     "queue_id": "chParent_v1_i_older_t", "queue_msg_id": 9}]'::jsonb);
select pgmq.create(queue_name := '66667777-8888-9999-0000-111122223333');
select pgmq.send(queue_name := '66667777-8888-9999-0000-111122223333', msg := '{"enter": 1}'::jsonb);
select pgmq.send(queue_name := '66667777-8888-9999-0000-111122223333', msg := '{"exit": 1}'::jsonb);
select pgmq.send(queue_name := '66667777-8888-9999-0000-111122223333', msg := '{"reenter": 1}'::jsonb);

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
select results_eq(
  $$ select fi.fsm_instance_status,
            (select array_agg(m.message->'eventData'->>'eventType') from pgmq.read(fi.id::text, 0, 10) m),
            (select count(*)::int from fsm_core.fsm_instance_and_fsm_workerlet w where w.fsm_instance_id = fi.id)
     from fsm_core.fsm_instance fi
     where fi.id = (select (r->'new_total_async_operation_queue_data'->1->>'queue_id')::uuid from both526) $$,
  $$ values ('"stopped"'::jsonb, ARRAY['xstate.stop'], 0) $$,
  'the exited child is stopped: its start event archived, its dispatch removed, only the xstate.stop wake-up left (#534)'
);

-- Entering the state again starts a new child; the stopped one stays stopped (#534).
select results_eq(
  $$ select (r->'new_total_async_operation_queue_data'->2->>'queue_id')::uuid
              <> (select (b.r->'new_total_async_operation_queue_data'->1->>'queue_id')::uuid from both526 b),
            jsonb_path_query_array(r->'new_total_async_operation_queue_data', '$[*].src')
     from fsm_core.archive_event_from_fsm_type_worker_v2(
       '66667777-8888-9999-0000-111122223333', 3::bigint,
       NULL, NULL, NULL,
       '[{"id": "0.chParent.Both", "src": "chChild", "input": {"n": 4}, "action_type": "entry",
          "asyncOperationType": "fsm", "asyncOperationVersion": "v1"}]'::jsonb,
       NULL, NULL,
       '"active"'::jsonb, '{"s": 3}'::jsonb, '{}'::jsonb, '{}'::jsonb) r $$,
  $$ values (true, '["older", "work526", "chChild"]'::jsonb) $$,
  're-entering the invoking state starts a new child instance (#534)'
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
select results_eq(
  $$ select (r->>'discarded')::boolean, r->>'discarded_reason', r->'internal_event_queue'
     from fsm_core.archive_event_from_fsm_type_worker_v2(
       '88889999-aaaa-bbbb-cccc-dddd00001111', NULL::bigint, NULL, NULL, NULL, NULL, NULL, NULL,
       '"active"'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
       '[]'::jsonb, '{"eventType": "xstate.done.state.e3"}'::jsonb) r $$,
  $$ values (true, 'internal_event_not_head'::text,
             '[{"eventType": "xstate.done.state.e2"}, {"eventType": "xstate.done.state.e3"}]'::jsonb) $$,
  'an internal event that isn''t the head of the queue was processed already: the macrostep is discarded, not raised (#534)'
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

-- ============================================================
-- SPEC-011 (b), #534: the target sequence and stopping invokes.
-- ============================================================
select has_function('fsm_core', 'stop_invoked_async_operation_v2', ARRAY['jsonb'],
  'stop_invoked_async_operation_v2(entry) exists (#534)');
select has_function('fsm_core', 'stop_child_fsm_v2', ARRAY['uuid'],
  'stop_child_fsm_v2(child id) exists (#534)');
select has_function('fsm_core', 'stop_fsm_instance_v2', ARRAY['uuid', 'text'],
  'stop_fsm_instance_v2(id, event name) exists (#534)');
select has_function('fsm_core', 'archive_fsm_instance_queue_messages_v2', ARRAY['uuid'],
  'archive_fsm_instance_queue_messages_v2(id) exists (#534)');
select has_function('fsm_core', 'discard_fsm_macrostep_v2',
  'discard_fsm_macrostep_v2 exists (#534)');

select throws_ok(
  $$ select fsm_core.stop_invoked_async_operation_v2('{"async_operation_type": "unsupported", "queue_id": "x"}'::jsonb) $$,
  'P0001',
  'stop_invoked_async_operation_v2: unsupported async operation type: unsupported',
  'stopping an entry of an unknown type raises, as starting one does (#534)'
);

-- The same message saved twice (a second fsmlet after its visibility timeout):
-- the second macrostep is discarded, so the message is applied once.
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version)
values ('a5340001-0000-0000-0000-000000000000'::uuid, 'dup534', 'v1');
select pgmq.create(queue_name := 'a5340001-0000-0000-0000-000000000000');
select pgmq.send(queue_name := 'a5340001-0000-0000-0000-000000000000', msg := '{"once": 1}'::jsonb);
select fsm_core.archive_event_from_fsm_type_worker_v2(
  'a5340001-0000-0000-0000-000000000000', 1::bigint, NULL, NULL, NULL, NULL, NULL, NULL,
  '"active"'::jsonb, '{"s": "first"}'::jsonb, '{}'::jsonb, '{}'::jsonb);
select results_eq(
  $$ select (r->>'discarded')::boolean, r->>'discarded_reason'
     from fsm_core.archive_event_from_fsm_type_worker_v2(
       'a5340001-0000-0000-0000-000000000000', 1::bigint, NULL, NULL, NULL, NULL, NULL, NULL,
       '"active"'::jsonb, '{"s": "second"}'::jsonb, '{}'::jsonb, '{}'::jsonb) r $$,
  $$ values (true, 'message_already_archived'::text) $$,
  'a message saved a second time is discarded (#534)'
);
select results_eq(
  $$ select fsm_instance_state,
            (select count(*)::int from fsm_core.fsm_instance_queue_event_logs l
             where l.fsm_instance_id = fi.id and l.event_status = 'discarded' and l.fsm_instance_queue_msg_id = 1)
     from fsm_core.fsm_instance fi where fi.id = 'a5340001-0000-0000-0000-000000000000'::uuid $$,
  $$ values ('{"s": "first"}'::jsonb, 1) $$,
  'the first save stands, and the discard is logged (#534)'
);

-- Status gate: an instance that isn't active takes no macrostep. Its message
-- is archived, nothing is started, and the row is not changed.
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version, fsm_instance_status)
values ('a5340002-0000-0000-0000-000000000000'::uuid, 'gate534', 'v1', '"stopped"'::jsonb);
select pgmq.create(queue_name := 'a5340002-0000-0000-0000-000000000000');
select pgmq.send(queue_name := 'a5340002-0000-0000-0000-000000000000', msg := '{"late": 1}'::jsonb);
select results_eq(
  $$ select (r->>'discarded')::boolean, r->>'discarded_reason', r->'fsm_instance_status'
     from fsm_core.archive_event_from_fsm_type_worker_v2(
       'a5340002-0000-0000-0000-000000000000', 1::bigint, NULL, NULL, NULL,
       '[{"id": "w", "src": "gatework", "input": {}, "action_type": "entry",
          "asyncOperationType": "internalAsyncOperation", "asyncOperationVersion": "v1",
          "asyncOperationLanguage": "typescript", "parentFsmName": "gate534", "parentFsmVersion": "v1"}]'::jsonb,
       NULL, NULL,
       '"active"'::jsonb, '{"s": "x"}'::jsonb, '{}'::jsonb, '{}'::jsonb) r $$,
  $$ values (true, 'instance_not_active'::text, '"stopped"'::jsonb) $$,
  'a macrostep for a stopped instance is discarded (#534)'
);
select results_eq(
  $$ select fi.fsm_instance_status, fi.fsm_instance_state,
            (select queue_length::int from pgmq.metrics('a5340002-0000-0000-0000-000000000000')),
            exists (select 1 from pgmq.list_queues() q where q.queue_name = 'gate534_v1_i_gatework_t')
     from fsm_core.fsm_instance fi where fi.id = 'a5340002-0000-0000-0000-000000000000'::uuid $$,
  $$ values ('"stopped"'::jsonb, NULL::jsonb, 0, false) $$,
  'its message is archived, its row unchanged, and its invoke never started (#534)'
);

-- A terminal status starts nothing and stops everything still running: the
-- invoke left in the totals, and the delayed event on the queue.
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version, total_schedule_queue_data, total_async_operation_queue_data)
values ('a5340003-0000-0000-0000-000000000000'::uuid, 'term534', 'v1',
  '[{"queue_data": {"eventData": {"eventType": "xstate.after.3600000.term534.wait"}, "queueMsgId": 1}}]'::jsonb,
  '[{"invoke_id": "w", "src": "work", "async_operation_type": "internalAsyncOperation",
     "queue_id": "term534_v1_i_work_t", "queue_msg_id": 1}]'::jsonb);
select pgmq.create(queue_name := 'a5340003-0000-0000-0000-000000000000');
select pgmq.send(queue_name := 'a5340003-0000-0000-0000-000000000000', msg := '{"timer": 1}'::jsonb, delay := 3600);
select pgmq.send(queue_name := 'a5340003-0000-0000-0000-000000000000', msg := '{"finish": 1}'::jsonb);
select pgmq.create(queue_name := 'term534_v1_i_work_t');
select pgmq.send(queue_name := 'term534_v1_i_work_t', msg := '{"invoke": "w"}'::jsonb);
create temp table term534 as
select fsm_core.archive_event_from_fsm_type_worker_v2(
  'a5340003-0000-0000-0000-000000000000', 2::bigint, NULL, NULL,
  '[{"type": "xstate.raise", "id": "xstate.after.1000.term534.final", "delay": 1000,
     "input": {"type": "xstate.after.1000.term534.final"}, "fsmType": "term534", "fsmVersion": "v1", "action_type": "entry"}]'::jsonb,
  '[{"id": "n", "src": "newwork", "input": {}, "action_type": "entry",
     "asyncOperationType": "internalAsyncOperation", "asyncOperationVersion": "v1",
     "asyncOperationLanguage": "typescript", "parentFsmName": "term534", "parentFsmVersion": "v1"}]'::jsonb,
  NULL, NULL,
  '"done"'::jsonb, '{"s": "done"}'::jsonb, '{}'::jsonb, '{}'::jsonb) r;
select results_eq(
  $$ select r->'terminal_archived_msg_ids', jsonb_array_length(r->'terminal_stopped_async_operation_queue_data'),
            r->'added_async_operation_queue_data', r->'added_schedule_queue_data'
     from term534 $$,
  $$ values ('[1]'::jsonb, 1, '[]'::jsonb, '[]'::jsonb) $$,
  'on done nothing is started or scheduled; the running invoke is stopped and the delayed event archived (#534)'
);
select results_eq(
  $$ select fi.total_async_operation_queue_data, fi.total_schedule_queue_data,
            (select queue_length::int from pgmq.metrics('a5340003-0000-0000-0000-000000000000')),
            (select queue_length::int from pgmq.metrics('term534_v1_i_work_t')),
            exists (select 1 from pgmq.list_queues() q where q.queue_name = 'term534_v1_i_newwork_t')
     from fsm_core.fsm_instance fi where fi.id = 'a5340003-0000-0000-0000-000000000000'::uuid $$,
  $$ values ('[]'::jsonb, '[]'::jsonb, 0, 0, false) $$,
  'the finished instance keeps no totals, no queued messages, and its actor''s message is cancelled (#534)'
);

-- The cycle cap is decided before the entry side: past it, nothing is started.
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version, fsm_instance_status, internal_event_queue, internal_event_count)
values ('a5340004-0000-0000-0000-000000000000'::uuid, 'cap534', 'v1', '"active"'::jsonb,
  '[{"eventType": "xstate.done.state.loop"}]'::jsonb, 100);
select pgmq.create(queue_name := 'a5340004-0000-0000-0000-000000000000');
select results_eq(
  $$ select r->'fsm_instance_status', r->'added_async_operation_queue_data',
            exists (select 1 from pgmq.list_queues() q where q.queue_name = 'cap534_v1_i_capwork_t')
     from fsm_core.archive_event_from_fsm_type_worker_v2(
       'a5340004-0000-0000-0000-000000000000', NULL::bigint, NULL, NULL, NULL,
       '[{"id": "c", "src": "capwork", "input": {}, "action_type": "entry",
          "asyncOperationType": "internalAsyncOperation", "asyncOperationVersion": "v1",
          "asyncOperationLanguage": "typescript", "parentFsmName": "cap534", "parentFsmVersion": "v1"}]'::jsonb,
       NULL, NULL,
       '"active"'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
       '[]'::jsonb, '{"eventType": "xstate.done.state.loop"}'::jsonb) r $$,
  $$ values ('"error"'::jsonb, '[]'::jsonb, false) $$,
  'past the cycle cap the status is error and the invoke is never started (#534)'
);

-- A cancelled schedule whose message is already gone is reported as failed.
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version, total_schedule_queue_data)
values ('a5340009-0000-0000-0000-000000000000'::uuid, 'fail534', 'v1',
  '[{"queue_data": {"eventData": {"eventType": "xstate.after.5.fail534.s"}, "queueMsgId": 999}}]'::jsonb);
select pgmq.create(queue_name := 'a5340009-0000-0000-0000-000000000000');
select pgmq.send(queue_name := 'a5340009-0000-0000-0000-000000000000', msg := '{"leave": 1}'::jsonb);
select results_eq(
  $$ select jsonb_array_length(r->'confirmed_removed_schedule_queue_data_failed'),
            jsonb_array_length(r->'confirmed_removed_schedule_queue_data_success'),
            r->'new_total_schedule_queue_data'
     from fsm_core.archive_event_from_fsm_type_worker_v2(
       'a5340009-0000-0000-0000-000000000000', 1::bigint,
       '[{"type": "xstate.cancel", "id": "xstate.after.5.fail534.s"}]'::jsonb, NULL, NULL, NULL, NULL, NULL,
       '"active"'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb) r $$,
  $$ values (1, 0, '[]'::jsonb) $$,
  'a cancel whose message was already archived is recorded as failed, and the entry still removed (#534)'
);

-- stop_child_fsm_v2 on a running child: stopped, dispatch removed, every
-- message archived (delayed included), its own actor cancelled, its own child
-- stopped too, a stop_child log row, and nothing sent to the parent.
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version)
values ('a5340005-0000-0000-0000-000000000000'::uuid, 'stopP534', 'v1');
select pgmq.create(queue_name := 'a5340005-0000-0000-0000-000000000000');
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version, fsm_instance_status, parent_fsm_instance_id, parent_invoke_id)
values ('a5340008-0000-0000-0000-000000000000'::uuid, 'stopG534', 'v1', '"active"'::jsonb,
  'a5340006-0000-0000-0000-000000000000'::uuid, '0.stopC534.grand');
select pgmq.create(queue_name := 'a5340008-0000-0000-0000-000000000000');
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version, fsm_instance_status, parent_fsm_instance_id, parent_invoke_id,
                                   total_async_operation_queue_data)
values ('a5340006-0000-0000-0000-000000000000'::uuid, 'stopC534', 'v1', '"active"'::jsonb,
  'a5340005-0000-0000-0000-000000000000'::uuid, '0.stopP534.child',
  '[{"invoke_id": "0.stopC534.w", "src": "cw", "async_operation_type": "internalAsyncOperation",
     "queue_id": "stopC534_v1_i_cw_t", "queue_msg_id": 1},
    {"invoke_id": "0.stopC534.grand", "src": "stopG534", "async_operation_type": "fsm",
     "queue_id": "a5340008-0000-0000-0000-000000000000", "queue_msg_id": 1}]'::jsonb);
select pgmq.create(queue_name := 'a5340006-0000-0000-0000-000000000000');
select pgmq.send(queue_name := 'a5340006-0000-0000-0000-000000000000', msg := '{"timer": 1}'::jsonb, delay := 3600);
select pgmq.send(queue_name := 'a5340006-0000-0000-0000-000000000000', msg := '{"event": 1}'::jsonb);
select pgmq.create(queue_name := 'stopC534_v1_i_cw_t');
select pgmq.send(queue_name := 'stopC534_v1_i_cw_t', msg := '{"invoke": "cw"}'::jsonb);
insert into fsm_core.fsm_instance_and_fsm_workerlet (fsm_instance_id, fsm_name, fsm_version, status)
values ('a5340006-0000-0000-0000-000000000000'::uuid, 'stopC534', 'v1', 'pending');

create temp table stop534 as
select fsm_core.stop_child_fsm_v2('a5340006-0000-0000-0000-000000000000'::uuid) r;
select results_eq(
  $$ select r->>'status', r->'archived_msg_ids', (r->>'cancelled_dispatch_count')::int,
            jsonb_path_query_array(r->'stopped_invokes', '$[*].status')
     from stop534 $$,
  $$ values ('stopped'::text, '[1, 2]'::jsonb, 1, '["canceled", "stopped"]'::jsonb) $$,
  'stop_child_fsm_v2 stops the child: dispatch removed, both messages archived, its actor and its child stopped (#534)'
);
select results_eq(
  $$ select fi.fsm_instance_status, fi.total_async_operation_queue_data, fi.total_schedule_queue_data, fi.internal_event_queue,
            (select array_agg(m.message->'eventData'->>'eventType') from pgmq.read(fi.id::text, 0, 10) m),
            (select queue_length::int from pgmq.metrics('stopC534_v1_i_cw_t')),
            (select g.fsm_instance_status from fsm_core.fsm_instance g where g.id = 'a5340008-0000-0000-0000-000000000000'::uuid)
     from fsm_core.fsm_instance fi where fi.id = 'a5340006-0000-0000-0000-000000000000'::uuid $$,
  $$ values ('"stopped"'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, ARRAY['xstate.stop'], 0, '"stopped"'::jsonb) $$,
  'the child is stopped with nothing left but the xstate.stop wake-up; its actor''s message is cancelled and its own child stopped (#534)'
);
select results_eq(
  $$ select l.event_status, l.event_data->>'parent_fsm_instance_id', l.event_data->>'parent_invoke_id',
            (select queue_length::int from pgmq.metrics('a5340005-0000-0000-0000-000000000000'))
     from fsm_core.fsm_instance_queue_event_logs l
     where l.fsm_instance_id = 'a5340006-0000-0000-0000-000000000000'::uuid and l.event_name = 'stop_child' $$,
  $$ values ('stopped'::text, 'a5340005-0000-0000-0000-000000000000'::text, '0.stopP534.child'::text, 0) $$,
  'the stop is logged on the child, and the parent is sent nothing (#534)'
);
select results_eq(
  $$ select fsm_core.stop_child_fsm_v2('a5340006-0000-0000-0000-000000000000'::uuid)->>'status' $$,
  $$ values ('not_active'::text) $$,
  'stopping a child that is already stopped does nothing (#534)'
);

-- A macrostep that was in flight when the child stopped is discarded; the
-- xstate.stop wake-up is archived with it.
select results_eq(
  $$ select (r->>'discarded')::boolean, r->>'discarded_reason',
            (select queue_length::int from pgmq.metrics('a5340006-0000-0000-0000-000000000000'))
     from fsm_core.archive_event_from_fsm_type_worker_v2(
       'a5340006-0000-0000-0000-000000000000', 3::bigint, NULL, NULL, NULL, NULL, NULL, NULL,
       '"done"'::jsonb, '{"s": "late"}'::jsonb, '{}'::jsonb, '{}'::jsonb) r $$,
  $$ values (true, 'instance_not_active'::text, 0) $$,
  'a stopped child''s macrostep is discarded, and it never reports to its parent (#534)'
);
select is(
  (select queue_length::int from pgmq.metrics('a5340005-0000-0000-0000-000000000000')),
  0,
  'the parent''s queue is still empty'
);

-- ============================================================
-- SPEC-011 (c), #535: stale done/error actor events. The parent holds an
-- actor invoke X (its current message is 2 on st535_v1_i_w_t) and a child
-- FSM invoke C (the child a5350002-...).
-- ============================================================
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version, total_async_operation_queue_data)
values ('a5350001-0000-0000-0000-000000000000'::uuid, 'st535', 'v1',
  '[{"invoke_id": "X", "src": "w", "async_operation_type": "internalAsyncOperation",
     "queue_id": "st535_v1_i_w_t", "queue_msg_id": 2},
    {"invoke_id": "C", "src": "kid535", "async_operation_type": "fsm",
     "queue_id": "a5350002-0000-0000-0000-000000000000", "queue_msg_id": 1}]'::jsonb);
select pgmq.create(queue_name := 'a5350001-0000-0000-0000-000000000000');

-- Sends eventType to the parent with the given source (NULL: none), returns
-- its message id.
create function pg_temp.send535(event_type text, source jsonb) returns bigint language sql as $$
  select (fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
    input_fsm_instance_id := 'a5350001-0000-0000-0000-000000000000'::uuid,
    input_fsm_instance_id_fsm_type := 'st535', input_fsm_instance_id_fsm_version := 'v1',
    input_event_name := event_type, input_event_action_type := 'async_operation_completed',
    input_event_data := '{}'::jsonb, input_event_source := source)->'queue_data'->>'queueMsgId')::bigint
$$;
-- Saves a macrostep for that message with the given state; returns the result.
create function pg_temp.save535(msg_id bigint, state jsonb) returns jsonb language sql as $$
  select fsm_core.archive_event_from_fsm_type_worker_v2(
    'a5350001-0000-0000-0000-000000000000', msg_id, NULL, NULL, NULL, NULL, NULL, NULL,
    '"active"'::jsonb, state, '{}'::jsonb, '{}'::jsonb)
$$;

select results_eq(
  $$ select (r->>'discarded')::boolean, r->>'discarded_reason'
     from pg_temp.save535(pg_temp.send535('xstate.done.actor.X',
       '{"invoke_id": "X", "queue_id": "st535_v1_i_w_t", "queue_msg_id": 1}'::jsonb), '{"s": "stale X"}'::jsonb) r $$,
  $$ values (true, 'stale_actor_event'::text) $$,
  'an actor result from an earlier invoke under the same id (queue_msg_id 1, not 2) is discarded (#535)'
);
select results_eq(
  $$ select l.event_name, l.event_data->'source'->>'queue_msg_id', l.event_status
     from fsm_core.fsm_instance_queue_event_logs l
     where l.fsm_instance_id = 'a5350001-0000-0000-0000-000000000000'::uuid and l.event_status = 'discarded' $$,
  $$ values ('xstate.done.actor.X'::text, '1'::text, 'discarded'::text) $$,
  'the discard is logged under the dropped event, with its source (#535)'
);
select results_eq(
  $$ select fsm_instance_state, jsonb_array_length(total_async_operation_queue_data)
     from fsm_core.fsm_instance where id = 'a5350001-0000-0000-0000-000000000000'::uuid $$,
  $$ values (NULL::jsonb, 2) $$,
  'a stale result changes nothing: no state saved, both invokes still held (#535)'
);
select results_eq(
  $$ select (r->>'discarded')::boolean
     from pg_temp.save535(pg_temp.send535('xstate.done.actor.X',
       '{"invoke_id": "X", "queue_id": "st535_v1_i_w_t", "queue_msg_id": 2}'::jsonb), '{"s": "current X"}'::jsonb) r $$,
  $$ values (false) $$,
  'the result of the invoke the parent holds is applied (#535)'
);
-- Read in its own statement: one statement doesn't see what a function it
-- calls has saved.
select results_eq(
  $$ select fsm_instance_state from fsm_core.fsm_instance where id = 'a5350001-0000-0000-0000-000000000000'::uuid $$,
  $$ values ('{"s": "current X"}'::jsonb) $$,
  'its state is saved (#535)'
);
select results_eq(
  $$ select r->>'discarded_reason'
     from pg_temp.save535(pg_temp.send535('xstate.error.actor.C',
       '{"invoke_id": "C", "queue_id": "a5359999-0000-0000-0000-000000000000"}'::jsonb), '{"s": "stale C"}'::jsonb) r $$,
  $$ values ('stale_actor_event'::text) $$,
  'a child''s result from another child instance under the same invoke id is discarded, error events too (#535)'
);
select results_eq(
  $$ select (r->>'discarded')::boolean
     from pg_temp.save535(pg_temp.send535('xstate.done.actor.C',
       '{"invoke_id": "C", "queue_id": "a5350002-0000-0000-0000-000000000000"}'::jsonb), '{"s": "current C"}'::jsonb) r $$,
  $$ values (false) $$,
  'the result of the child the parent holds is applied (#535)'
);
select results_eq(
  $$ select r->>'discarded_reason'
     from pg_temp.save535(pg_temp.send535('xstate.done.actor.Q',
       '{"invoke_id": "Q", "queue_id": "st535_v1_i_q_t", "queue_msg_id": 7}'::jsonb), '{"s": "exited"}'::jsonb) r $$,
  $$ values ('stale_actor_event'::text) $$,
  'a result for an invoke the parent no longer holds at all (its state exited) is discarded (#535)'
);
select results_eq(
  $$ select (r->>'discarded')::boolean
     from pg_temp.save535(pg_temp.send535('xstate.done.actor.Z', NULL), '{"s": "no source"}'::jsonb) r $$,
  $$ values (false) $$,
  'a result without a source (sent before #533, or by the API) is processed as before (#535)'
);
select results_eq(
  $$ select (r->>'discarded')::boolean
     from pg_temp.save535(pg_temp.send535('ORDER_PLACED',
       '{"invoke_id": "nope", "queue_id": "nope"}'::jsonb), '{"s": "external"}'::jsonb) r $$,
  $$ values (false) $$,
  'only done/error actor events are checked: another event with a source is processed (#535)'
);

-- Step 11: a child's result carries the source its parent's entry names.
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version, parent_fsm_instance_id, parent_invoke_id)
values ('a5350002-0000-0000-0000-000000000000'::uuid, 'kid535', 'v1',
  'a5350001-0000-0000-0000-000000000000'::uuid, 'C');
select pgmq.create(queue_name := 'a5350002-0000-0000-0000-000000000000');
select pgmq.send(queue_name := 'a5350002-0000-0000-0000-000000000000', msg := '{"finish": 1}'::jsonb);
select results_eq(
  $$ select r->'parent_notify_result'->'queue_data'->'source'
     from fsm_core.archive_event_from_fsm_type_worker_v2(
       'a5350002-0000-0000-0000-000000000000', 1::bigint, NULL, NULL, NULL, NULL, NULL, NULL,
       '"done"'::jsonb, '"Done"'::jsonb, '{}'::jsonb, '{}'::jsonb) r $$,
  $$ values ('{"invoke_id": "C", "queue_id": "a5350002-0000-0000-0000-000000000000"}'::jsonb) $$,
  'a child FSM''s done event carries {invoke_id, queue_id: <child id>}, matching its parent''s entry (#535)'
);

-- ============================================================
-- #532: a child ending in error sends its error, not its context, as the
-- xstate.error.actor.<id> payload; done still sends the context.
-- ============================================================
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version)
values ('a5320000-0000-0000-0000-000000000000'::uuid, 'par532', 'v1');
select pgmq.create(queue_name := 'a5320000-0000-0000-0000-000000000000');
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version, parent_fsm_instance_id, parent_invoke_id, fsm_instance_error,
                                   fsm_instance_status, internal_event_queue, internal_event_count)
values
  ('a5320001-0000-0000-0000-000000000000'::uuid, 'kid532', 'v1', 'a5320000-0000-0000-0000-000000000000'::uuid, 'E1',
   NULL, NULL, '[]'::jsonb, 0),
  ('a5320002-0000-0000-0000-000000000000'::uuid, 'kid532', 'v1', 'a5320000-0000-0000-0000-000000000000'::uuid, 'E2',
   NULL, '"active"'::jsonb, '[{"eventType": "xstate.done.state.loop"}]'::jsonb, 100),
  ('a5320003-0000-0000-0000-000000000000'::uuid, 'kid532', 'v1', 'a5320000-0000-0000-0000-000000000000'::uuid, 'E3',
   '{"message": "earlier"}'::jsonb, NULL, '[]'::jsonb, 0),
  ('a5320004-0000-0000-0000-000000000000'::uuid, 'kid532', 'v1', 'a5320000-0000-0000-0000-000000000000'::uuid, 'D4',
   NULL, NULL, '[]'::jsonb, 0);
select pgmq.create(queue_name := q) from unnest(ARRAY[
  'a5320001-0000-0000-0000-000000000000', 'a5320003-0000-0000-0000-000000000000',
  'a5320004-0000-0000-0000-000000000000']) q;
select pgmq.create(queue_name := 'a5320002-0000-0000-0000-000000000000');
select pgmq.send(queue_name := q, msg := '{"go": 1}'::jsonb) from unnest(ARRAY[
  'a5320001-0000-0000-0000-000000000000', 'a5320003-0000-0000-0000-000000000000',
  'a5320004-0000-0000-0000-000000000000']) q;

-- An unhandled actor error (#520): the worker saves status error with it.
select results_eq(
  $$ select r->'parent_notify_result'->'queue_data'->'eventData'->>'eventType',
            r->'parent_notify_result'->'queue_data'->'eventData'->'eventPayload',
            r->'parent_notify_result'->>'error_message'
     from fsm_core.archive_event_from_fsm_type_worker_v2(
       'a5320001-0000-0000-0000-000000000000', 1::bigint, NULL, NULL, NULL, NULL, NULL, NULL,
       '"error"'::jsonb, '"Failed"'::jsonb, '{"ctx": "not this"}'::jsonb, '{}'::jsonb,
       '[]'::jsonb, NULL, '{"message": "boom"}'::jsonb) r $$,
  $$ values ('xstate.error.actor.E1'::text, '{"message": "boom"}'::jsonb, 'boom'::text) $$,
  'a child ending in error sends its error as the payload, not its context (#532)'
);
-- The cycle cap sets error itself: its infinite-loop error is sent.
select results_eq(
  $$ select r->'parent_notify_result'->'queue_data'->'eventData'->'eventPayload'->>'message' like 'Infinite loop: more than 100 internal events in a row%'
     from fsm_core.archive_event_from_fsm_type_worker_v2(
       'a5320002-0000-0000-0000-000000000000', NULL::bigint, NULL, NULL, NULL, NULL, NULL, NULL,
       '"active"'::jsonb, '{}'::jsonb, '{"ctx": "not this"}'::jsonb, '{}'::jsonb,
       '[]'::jsonb, '{"eventType": "xstate.done.state.loop"}'::jsonb) r $$,
  $$ values (true) $$,
  'a child set to error by the cycle cap sends the infinite-loop error (#532)'
);
-- No new error passed: the error already on the row is sent.
select results_eq(
  $$ select r->'parent_notify_result'->'queue_data'->'eventData'->'eventPayload'
     from fsm_core.archive_event_from_fsm_type_worker_v2(
       'a5320003-0000-0000-0000-000000000000', 1::bigint, NULL, NULL, NULL, NULL, NULL, NULL,
       '"error"'::jsonb, '"Failed"'::jsonb, '{"ctx": "not this"}'::jsonb, '{}'::jsonb) r $$,
  $$ values ('{"message": "earlier"}'::jsonb) $$,
  'with no new error, the error the child already has is sent (#532)'
);
-- done is unchanged: the context stands in for the machine's output.
select results_eq(
  $$ select r->'parent_notify_result'->'queue_data'->'eventData'->'eventPayload',
            r->'parent_notify_result'->>'error_message'
     from fsm_core.archive_event_from_fsm_type_worker_v2(
       'a5320004-0000-0000-0000-000000000000', 1::bigint, NULL, NULL, NULL, NULL, NULL, NULL,
       '"done"'::jsonb, '"Done"'::jsonb, '{"ctx": "this"}'::jsonb, '{}'::jsonb) r $$,
  $$ values ('{"ctx": "this"}'::jsonb, NULL::text) $$,
  'a child reaching done still sends its context, with no error message (#532)'
);

select * from finish();
rollback;
