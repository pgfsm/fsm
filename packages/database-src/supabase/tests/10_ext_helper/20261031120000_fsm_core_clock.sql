-- Clock seams (SPEC-015 §2, #642): fsm_core.tx_now() / wall_now() behave as
-- now() / clock_timestamp() unless a login in fsm_sim sets fsm_core.sim_now.
begin;
select plan(14);

-- Tier 1: structural.
select has_function('fsm_core', 'tx_now', ARRAY[]::text[], 'fsm_core.tx_now() exists');
select has_function('fsm_core', 'wall_now', ARRAY[]::text[], 'fsm_core.wall_now() exists');
select function_returns('fsm_core', 'tx_now', ARRAY[]::text[], 'timestamp with time zone',
  'tx_now() returns timestamptz');
select volatility_is('fsm_core', 'tx_now', ARRAY[]::text[], 'stable',
  'tx_now() is STABLE, like now()');
select volatility_is('fsm_core', 'wall_now', ARRAY[]::text[], 'volatile',
  'wall_now() is VOLATILE, like clock_timestamp()');
select ok(has_function_privilege('fsm_worker', 'fsm_core.tx_now()', 'execute')
      and has_function_privilege('fsm_worker', 'fsm_core.wall_now()', 'execute'),
  'fsm_worker can execute both (heartbeats, workerlet column defaults)');

-- Tier 2: GUC unset, the production path.
select is(fsm_core.tx_now(), now(), 'tx_now() = now() with fsm_core.sim_now unset');
do $$ begin perform pg_sleep(0.01); end $$;
select ok(fsm_core.wall_now() > now(),
  'wall_now() follows clock_timestamp(): it advances within the transaction');

do $$ begin perform set_config('fsm_core.sim_now', '', true); end $$;
select is(fsm_core.tx_now(), now(), 'an empty fsm_core.sim_now counts as unset');

-- Tier 3: GUC set by a login that is not in fsm_sim, so it is ignored. A
-- superuser counts as a member of every role, so this tier only means
-- something when the tests don't run as one (local Supabase's postgres isn't).
do $$ begin perform set_config('fsm_core.sim_now', '2030-01-01 00:00:00+00', true); end $$;
select case when (select rolsuper from pg_roles where rolname = session_user)
  then skip('session_user is a superuser, so it is a member of fsm_sim', 2)
  else collect_tap(
    is(fsm_core.tx_now(), now(), 'tx_now() ignores fsm_core.sim_now outside fsm_sim'),
    ok(fsm_core.wall_now() <> '2030-01-01 00:00:00+00'::timestamptz,
      'wall_now() ignores fsm_core.sim_now outside fsm_sim'))
end;

-- Tier 4: the same login, granted fsm_sim (rolled back with the test). By
-- name: GRANT … TO CURRENT_USER segfaults the backend on Supabase PG 15.8.
do $$
begin
  execute format('grant fsm_sim to %I', session_user);
end;
$$;
select is(fsm_core.tx_now(), '2030-01-01 00:00:00+00'::timestamptz,
  'tx_now() returns fsm_core.sim_now for a login in fsm_sim');
select is(fsm_core.wall_now(), '2030-01-01 00:00:00+00'::timestamptz,
  'wall_now() returns fsm_core.sim_now for a login in fsm_sim');

-- session_user, not current_user: switching role keeps the login's membership,
-- which is what a SECURITY DEFINER function (current_user = owner) sees too.
-- Read as fsm_worker, assert as the owner (fsm_worker can't see pgTAP).
create function pg_temp.tx_now_as(r text) returns timestamptz
language plpgsql as $$
declare
  v timestamptz;
begin
  perform set_config('role', r, true);
  v := fsm_core.tx_now();
  reset role;
  return v;
end;
$$;
select is(pg_temp.tx_now_as('fsm_worker'), '2030-01-01 00:00:00+00'::timestamptz,
  'membership is checked on the login, not the current role');

select * from finish();
rollback;
