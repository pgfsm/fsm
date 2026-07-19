begin;
select plan(8);

select has_function('fsm_core', 'async_operation_schedule_next_pending', ARRAY['integer'],
  'async_operation_schedule_next_pending(integer) exists');

-- Isolate from any pre-existing rows in the shared local dev database; the
-- outer rollback restores whatever was there before this test ran.
delete from fsm_core.async_operation_instance_and_async_operation_workerlet;
delete from fsm_core.async_operation_workerlet;

select results_eq(
  $$ select fsm_core.async_operation_schedule_next_pending() $$,
  $$ values (false) $$,
  'empty dispatch queue: nothing to schedule'
);

insert into fsm_core.async_operation_instance_and_async_operation_workerlet
  (async_operation_instance_id, async_operation_name, async_operation_version,
   async_operation_type, parent_fsm_name, parent_fsm_version, async_operation_language)
values
  ('22222222-2222-2222-2222-222222222222'::uuid, 'opY', '1', 'internalAsync', 'fsmY', '1', 'python');

select results_eq(
  $$ select fsm_core.async_operation_schedule_next_pending() $$,
  $$ values (false) $$,
  'pending entry exists but no workerlet is registered: nothing to schedule'
);
select results_eq(
  $$ select status from fsm_core.async_operation_instance_and_async_operation_workerlet
     where async_operation_instance_id = '22222222-2222-2222-2222-222222222222'::uuid $$,
  $$ values ('pending'::text) $$,
  'entry remains pending when no workerlet is available'
);

-- A workerlet that does not support opY/1/fsmY/1 at all.
insert into fsm_core.async_operation_workerlet
  (async_operation_workerlet_id, async_operation_workerlet_pid, supported_async_operations,
   max_pid_number, active_pid_number, last_heartbeat)
values
  ('44444444-4444-4444-4444-444444444444'::uuid, 'pid-other',
   '[{"async_operation_name": "somethingElse", "async_operation_version": "1", "parent_fsm_name": "fsmY", "parent_fsm_version": "1"}]'::jsonb,
   8, 0, now());

select results_eq(
  $$ select fsm_core.async_operation_schedule_next_pending() $$,
  $$ values (false) $$,
  'a workerlet that does not support this operation is not chosen'
);

-- A capable workerlet, but its heartbeat is 60s stale.
insert into fsm_core.async_operation_workerlet
  (async_operation_workerlet_id, async_operation_workerlet_pid, supported_async_operations,
   max_pid_number, active_pid_number, last_heartbeat)
values
  ('11111111-1111-1111-1111-111111111111'::uuid, 'pid-capable',
   '[{"async_operation_name": "opY", "async_operation_version": "1", "parent_fsm_name": "fsmY", "parent_fsm_version": "1"}]'::jsonb,
   8, 0, now() - interval '60 seconds');

select results_eq(
  $$ select fsm_core.async_operation_schedule_next_pending(30) $$,
  $$ values (false) $$,
  'a capable workerlet with a stale (60s) heartbeat is excluded under the default 30s threshold'
);
select results_eq(
  $$ select fsm_core.async_operation_schedule_next_pending(90) $$,
  $$ values (true) $$,
  'the same workerlet is accepted once the staleness threshold is widened to 90s'
);
select results_eq(
  $$ select status, async_operation_workerlet_id
     from fsm_core.async_operation_instance_and_async_operation_workerlet
     where async_operation_instance_id = '22222222-2222-2222-2222-222222222222'::uuid $$,
  $$ values ('scheduled'::text, '11111111-1111-1111-1111-111111111111'::uuid) $$,
  'a successful schedule assigns the capable workerlet and flips status to scheduled'
);

select * from finish();
rollback;
