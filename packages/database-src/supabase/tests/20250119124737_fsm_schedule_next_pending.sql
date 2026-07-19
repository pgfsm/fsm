begin;
select plan(8);

select has_function('fsm_core', 'schedule_next_pending', ARRAY['integer'],
  'schedule_next_pending(integer) exists');

-- Isolate from any pre-existing rows in the shared local dev database.
delete from fsm_core.fsm_instance_and_fsm_workerlet;
delete from fsm_core.fsm_workerlet;

select results_eq(
  $$ select fsm_core.schedule_next_pending() $$,
  $$ values (false) $$,
  'empty dispatch queue: nothing to schedule'
);

insert into fsm_core.fsm_instance_and_fsm_workerlet (fsm_instance_id, fsm_name, fsm_version)
values ('22222222-2222-2222-2222-222222222222'::uuid, 'schedFsm', '1');

select results_eq(
  $$ select fsm_core.schedule_next_pending() $$,
  $$ values (false) $$,
  'pending entry exists but no fsmlet is registered: nothing to schedule'
);
select results_eq(
  $$ select status from fsm_core.fsm_instance_and_fsm_workerlet
     where fsm_instance_id = '22222222-2222-2222-2222-222222222222'::uuid $$,
  $$ values ('pending'::text) $$,
  'entry remains pending when no fsmlet is available'
);

-- A fsmlet that does not have this FSM module loaded at all.
insert into fsm_core.fsm_workerlet
  (fsm_workerlet_id, fsm_workerlet_pid, fsm_modules, max_concurrency, active_workers, last_heartbeat)
values
  ('44444444-4444-4444-4444-444444444444'::uuid, 'pid-other',
   '[{"fsm_name": "somethingElse", "fsm_version": "1"}]'::jsonb, 8, 0, now());

select results_eq(
  $$ select fsm_core.schedule_next_pending() $$,
  $$ values (false) $$,
  'a fsmlet that does not have this FSM module loaded is not chosen'
);

-- A capable fsmlet, but its heartbeat is 60s stale.
insert into fsm_core.fsm_workerlet
  (fsm_workerlet_id, fsm_workerlet_pid, fsm_modules, max_concurrency, active_workers, last_heartbeat)
values
  ('11111111-1111-1111-1111-111111111111'::uuid, 'pid-capable',
   '[{"fsm_name": "schedFsm", "fsm_version": "1"}]'::jsonb, 8, 0, now() - interval '60 seconds');

select results_eq(
  $$ select fsm_core.schedule_next_pending(30) $$,
  $$ values (false) $$,
  'a capable fsmlet with a stale (60s) heartbeat is excluded under the default 30s threshold'
);
select results_eq(
  $$ select fsm_core.schedule_next_pending(90) $$,
  $$ values (true) $$,
  'the same fsmlet is accepted once the staleness threshold is widened to 90s'
);
select results_eq(
  $$ select status, fsm_workerlet_id from fsm_core.fsm_instance_and_fsm_workerlet
     where fsm_instance_id = '22222222-2222-2222-2222-222222222222'::uuid $$,
  $$ values ('scheduled'::text, '11111111-1111-1111-1111-111111111111'::uuid) $$,
  'a successful schedule assigns the capable fsmlet and flips status to scheduled'
);

select * from finish();
rollback;
