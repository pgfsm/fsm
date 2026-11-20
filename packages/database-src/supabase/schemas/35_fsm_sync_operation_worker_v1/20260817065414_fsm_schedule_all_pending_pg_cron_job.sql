-- The fsm_schedule_all_pending pg_cron job: drains the fsm dispatch queue via
-- fsm_core.schedule_all_pending() every 5 seconds (SPEC-003, Option C; pg_cron
-- 1.5+ supports the sub-minute 'N seconds' syntax).
--
-- pg_cron is required (SPEC-016). The install SQL and the 1.2.0 baseline
-- migration register the job by calling fsm_core.register_scheduler_job_v2(); an admin
-- re-registers or checks it through the API (GET/POST /api/v1/admin/scheduler,
-- `pgfsmctl scheduler status|register`). Both functions are SECURITY DEFINER
-- (40_access_control), so the job always belongs to the schema owner and the
-- API never needs the owner's login.
--
-- Interval and stale threshold are changeable without a deploy:
--   SELECT fsm_core.register_scheduler_job_v2('10 seconds');
-- Run history: cron.job_run_details.

create or replace function fsm_core.scheduler_job_status_v2()
returns jsonb
language plpgsql
as $$
declare
  job record;
begin
  select jobid, schedule, command, active
    into job
    from cron.job
   where jobname = 'fsm_schedule_all_pending';
  if not found then
    return jsonb_build_object('jobname', 'fsm_schedule_all_pending', 'registered', false);
  end if;
  return jsonb_build_object(
    'jobname', 'fsm_schedule_all_pending',
    'registered', true,
    'jobid', job.jobid,
    'schedule', job.schedule,
    'command', job.command,
    'active', job.active
  );
end;
$$;

-- Idempotent: cron.schedule() errors on a duplicate jobname, so an existing
-- job is unscheduled first.
create or replace function fsm_core.register_scheduler_job_v2(
  input_schedule text default '5 seconds'
)
returns jsonb
language plpgsql
as $$
begin
  if exists (select 1 from cron.job where jobname = 'fsm_schedule_all_pending') then
    perform cron.unschedule('fsm_schedule_all_pending');
  end if;
  perform cron.schedule(
    'fsm_schedule_all_pending',
    input_schedule,
    'SELECT fsm_core.schedule_all_pending();'
  );
  return fsm_core.scheduler_job_status_v2();
end;
$$;
