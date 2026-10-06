-- Precondition: the job is registered by the deploy step, not by migrations
-- (cron.schedule() is data-level, so `supabase db diff` never captures it).
-- After `supabase db reset`, run from packages/fsm-ctl-ts:
--   deno task pgfsmctl db cron register --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres
-- CI does this before `supabase test db` (#468).
begin;
select plan(3);

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

select * from finish();
rollback;
