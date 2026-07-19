begin;
select plan(8);

-- Note: fsm_core.stop_event_for_fsm_worker_v1 is intentionally not tested here
-- — the schema file itself notes it was "renamed from the original _v2" and is
-- the legacy pgmq/in-process worker flow, superseded by the scheduler-model v2.
select has_function('fsm_core', 'stop_event_for_fsm_worker_v2', ARRAY['uuid'],
  'stop_event_for_fsm_worker_v2(uuid) exists');
select has_function('fsm_core', 'resume_event_for_fsm_worker_v2', ARRAY['uuid'],
  'resume_event_for_fsm_worker_v2(uuid) exists');

delete from fsm_core.fsm_instance_and_fsm_workerlet where fsm_name = 'stopFsm' and fsm_version = 'v1';
delete from fsm_core.fsm_instance_queue_event_logs
  where fsm_instance_id in (select id from fsm_core.fsm_instance where fsm_name = 'stopFsm' and fsm_version = 'v1');
delete from fsm_core.fsm_instance where fsm_name = 'stopFsm' and fsm_version = 'v1';
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version)
values ('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, 'stopFsm', 'v1');

select results_eq(
  $$ select fsm_core.stop_event_for_fsm_worker_v2('00000000-0000-0000-0000-000000000098'::uuid) $$,
  $$ values ('{"status": "fsm_not_found", "fsm_instance_id": "00000000-0000-0000-0000-000000000098"}'::jsonb) $$,
  'stopping an unknown instance reports fsm_not_found'
);
select results_eq(
  $$ select (fsm_core.stop_event_for_fsm_worker_v2('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid) - 'event_log_id') $$,
  $$ values ('{"status": "not_queued", "cancelled_count": 0, "fsm_instance_id": "cccccccc-cccc-cccc-cccc-cccccccccccc"}'::jsonb) $$,
  'stopping an instance with no pending/scheduled dispatch entry reports not_queued'
);

insert into fsm_core.fsm_instance_and_fsm_workerlet (fsm_instance_id, fsm_name, fsm_version, status)
values ('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, 'stopFsm', 'v1', 'pending');

select results_eq(
  $$ select (fsm_core.stop_event_for_fsm_worker_v2('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid) - 'event_log_id') $$,
  $$ values ('{"status": "cancelled", "cancelled_count": 1, "fsm_instance_id": "cccccccc-cccc-cccc-cccc-cccccccccccc"}'::jsonb) $$,
  'stopping an instance with a pending dispatch entry cancels it'
);
select results_eq(
  $$ select count(*) from fsm_core.fsm_instance_and_fsm_workerlet
     where fsm_instance_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid $$,
  $$ values (0::bigint) $$,
  'the cancelled dispatch row is actually deleted'
);

select results_eq(
  $$ select fsm_core.resume_event_for_fsm_worker_v2('00000000-0000-0000-0000-000000000098'::uuid) $$,
  $$ values ('{"status": "fsm_not_found", "fsm_instance_id": "00000000-0000-0000-0000-000000000098"}'::jsonb) $$,
  'resuming an unknown instance reports fsm_not_found'
);
select results_eq(
  $$ select fsm_core.resume_event_for_fsm_worker_v2('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid) $$,
  $$ values ('{"status": "queued", "fsm_name": "stopFsm", "fsm_version": "v1", "fsm_instance_id": "cccccccc-cccc-cccc-cccc-cccccccccccc"}'::jsonb) $$,
  'resuming a known instance re-enqueues it with its own fsm_name/version'
);

select * from finish();
rollback;
