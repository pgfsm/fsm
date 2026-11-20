-- The fsm_schedule_all_pending pg_cron job (SPEC-016, #688): the 1.2.0
-- baseline migration registers it, so `supabase db reset` (like the full install and
-- the PGXN form) leaves it registered with no deploy step. An admin checks
-- and re-registers it through scheduler_job_status_v2() and
-- register_scheduler_job_v2(), which the API calls as fsm_admin.
begin;
select plan(12);

select has_extension('pg_cron', 'pg_cron extension is installed');

select results_eq(
  $$ select schedule, active from cron.job where jobname = 'fsm_schedule_all_pending' $$,
  $$ values ('5 seconds'::text, true) $$,
  'fsm_schedule_all_pending pg_cron job is registered on a 5s interval and active'
);

select matches(
  (select command from cron.job where jobname = 'fsm_schedule_all_pending'),
  'fsm_core\.schedule_all_pending',
  'the registered job calls fsm_core.schedule_all_pending()'
);

-- Status
select is(
  fsm_core.scheduler_job_status_v2() - 'jobid',
  jsonb_build_object(
    'jobname', 'fsm_schedule_all_pending', 'registered', true,
    'schedule', '5 seconds', 'command', 'SELECT fsm_core.schedule_all_pending();',
    'active', true
  ),
  'scheduler_job_status_v2() reports the registered job'
);

-- Register: replaces the job, never duplicates it
select is(
  fsm_core.register_scheduler_job_v2('10 seconds') ->> 'schedule',
  '10 seconds',
  'register_scheduler_job_v2(schedule) returns the new status'
);
select is(
  (select count(*)::int from cron.job where jobname = 'fsm_schedule_all_pending'),
  1,
  're-registering replaces the job: still exactly one'
);
select is(
  fsm_core.register_scheduler_job_v2() ->> 'schedule',
  '5 seconds',
  'the default schedule is 5 seconds'
);

-- Unregistered
select cron.unschedule('fsm_schedule_all_pending');
select is(
  fsm_core.scheduler_job_status_v2(),
  '{"jobname": "fsm_schedule_all_pending", "registered": false}'::jsonb,
  'scheduler_job_status_v2() reports a missing job as registered: false'
);
select ok(
  (fsm_core.register_scheduler_job_v2() ->> 'registered')::boolean,
  'register_scheduler_job_v2() registers a missing job'
);

-- Access: fsm_admin only, as SECURITY DEFINER (the job belongs to the owner)
select ok(
  has_function_privilege('fsm_admin', 'fsm_core.register_scheduler_job_v2(text)', 'execute')
    and has_function_privilege('fsm_admin', 'fsm_core.scheduler_job_status_v2()', 'execute'),
  'fsm_admin can check and register the job'
);
select ok(
  not has_function_privilege('fsm_operator', 'fsm_core.register_scheduler_job_v2(text)', 'execute')
    and not has_function_privilege('fsm_worker', 'fsm_core.register_scheduler_job_v2(text)', 'execute'),
  'fsm_operator and fsm_worker cannot register it'
);
select ok(
  (select bool_and(prosecdef) from pg_proc
    where oid in ('fsm_core.register_scheduler_job_v2(text)'::regprocedure,
                  'fsm_core.scheduler_job_status_v2()'::regprocedure)),
  'both are SECURITY DEFINER'
);

select * from finish();
rollback;
