-- fsm_core access control (SPEC-009 §1–2, #469).
--
-- CREATE ROLE and function EXECUTE grants aren't captured by `supabase db
-- diff`, so they live hand-written in the migration. These tests are what
-- catches the schema file and the migration drifting apart, and any new
-- fsm_core function left executable by PUBLIC.
begin;
select plan(26);

-- Runs q as role r; returns 'ok' or the SQLSTATE it failed with. The owner
-- (postgres) is a member of every fsm_* role, so it can switch to them.
create function pg_temp.sqlstate_as(r text, q text) returns text
language plpgsql as $$
declare
  st text := 'ok';
begin
  begin
    perform set_config('role', r, true);
    execute q;
  exception when others then
    st := sqlstate;
  end;
  reset role;
  return st;
end;
$$;

-- Runs q as role r and returns its single text result.
create function pg_temp.value_as(r text, q text) returns text
language plpgsql as $$
declare
  v text;
begin
  perform set_config('role', r, true);
  execute q into v;
  reset role;
  return v;
end;
$$;

-- ── Roles ───────────────────────────────────────────────────────────────────
select has_role('fsm_operator');
select has_role('fsm_admin');
select has_role('fsm_worker');
select has_role('fsm_authenticator');

select results_eq(
  $$ select rolcanlogin, rolinherit from pg_roles where rolname = 'fsm_authenticator' $$,
  $$ values (true, false) $$,
  'fsm_authenticator is LOGIN and NOINHERIT'
);
select ok(pg_has_role('fsm_admin', 'fsm_operator', 'member'), 'fsm_admin is a member of fsm_operator');
select ok(pg_has_role('fsm_authenticator', 'fsm_operator', 'member'), 'fsm_authenticator is a member of fsm_operator');
select ok(not pg_has_role('fsm_authenticator', 'fsm_admin', 'member'),
  'fsm_authenticator is not a member of fsm_admin (deployments grant that)');

-- ── Function boundary ───────────────────────────────────────────────────────
select is(
  (select count(*)::int from pg_proc p
   where p.pronamespace = 'fsm_core'::regnamespace
     and has_function_privilege('public', p.oid, 'execute')
     and not exists (select 1 from pg_depend d
                     where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')),
  0,
  'no fsm_core function (outside extensions) is executable by PUBLIC'
);

select is(
  (select count(*)::int from pg_proc p
   where p.pronamespace = 'fsm_core'::regnamespace
     and p.prosecdef
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')),
  0,
  'every SECURITY DEFINER fsm_core function pins search_path'
);

select is(
  (select count(*)::int from pg_proc p
   where p.pronamespace = 'fsm_core'::regnamespace and p.prosecdef
     and exists (select 1 from aclexplode(p.proacl) a
                 where a.grantee in ('fsm_operator'::regrole, 'fsm_admin'::regrole,
                                     'fsm_worker'::regrole, 'fsm_authenticator'::regrole))),
  (select count(*)::int from pg_proc p
   where p.pronamespace = 'fsm_core'::regnamespace and p.prosecdef),
  'every SECURITY DEFINER fsm_core function is granted to an fsm_* role'
);

-- ── fsm_operator ────────────────────────────────────────────────────────────
select is(pg_temp.sqlstate_as('fsm_operator',
  $$ select fsm_core.load_fsm_from_json_v2('{}'::jsonb, null, 'x', 'v01', null) $$),
  '42501', 'fsm_operator cannot load FSM definitions');
select is(pg_temp.sqlstate_as('fsm_operator',
  $$ select fsm_core.create_api_key('x', 'fsm_admin') $$),
  '42501', 'fsm_operator cannot create API keys');
select is(pg_temp.sqlstate_as('fsm_operator', $$ select count(*) from fsm_core.api_keys $$),
  '42501', 'fsm_operator cannot read fsm_core.api_keys');
select is(pg_temp.sqlstate_as('fsm_operator', $$ select count(*) from fsm_core.fsm_instance $$),
  'ok', 'fsm_operator can list instances');

-- ── fsm_admin and API keys ──────────────────────────────────────────────────
select is(pg_temp.sqlstate_as('fsm_admin', $$ select count(*) from fsm_core.fsm_instance $$),
  'ok', 'fsm_admin inherits fsm_operator');

create temp table k as
select pg_temp.value_as('fsm_admin',
  $$ select (fsm_core.create_api_key('pgtap-admin', 'fsm_admin'))->>'key' $$) as key;
grant select on k to fsm_authenticator;

select matches((select key from k), '^pgfsm_admin_[0-9a-f]{64}$', 'admin key has the pgfsm_admin_ prefix');
select results_eq(
  $$ select prefix, key_hash from fsm_core.api_keys where name = 'pgtap-admin' $$,
  $$ select left(key, 20), sha256(convert_to(key, 'UTF8')) from k $$,
  'only a display prefix and sha256(key) are stored'
);
select is(pg_temp.value_as('fsm_authenticator',
  $$ select fsm_core.verify_api_key(sha256(convert_to((select key from k), 'UTF8'))) $$),
  'fsm_admin', 'verify_api_key returns the key''s role');
select is(pg_temp.value_as('fsm_authenticator',
  $$ select fsm_core.verify_api_key(sha256(convert_to('pgfsm_admin_nope', 'UTF8'))) $$),
  null, 'verify_api_key returns NULL for an unknown key');
select ok(pg_temp.value_as('fsm_admin', $$ select fsm_core.revoke_api_key('pgtap-admin')::text $$)::boolean,
  'revoke_api_key revokes a live key');
select is(pg_temp.value_as('fsm_authenticator',
  $$ select fsm_core.verify_api_key(sha256(convert_to((select key from k), 'UTF8'))) $$),
  null, 'verify_api_key returns NULL after revocation');

-- ── fsm_authenticator ───────────────────────────────────────────────────────
select is(pg_temp.sqlstate_as('fsm_authenticator', $$ select count(*) from fsm_core.fsm_instance $$),
  '42501', 'fsm_authenticator has no rights of its own (NOINHERIT)');
select is(pg_temp.sqlstate_as('fsm_authenticator', $$ select fsm_core.list_api_keys() $$),
  '42501', 'fsm_authenticator cannot list API keys');

-- ── fsm_worker ──────────────────────────────────────────────────────────────
select is(pg_temp.sqlstate_as('fsm_worker', $$ select fsm_core.schedule_next_pending(30) $$),
  'ok', 'fsm_worker can run the scheduler');
select is(pg_temp.sqlstate_as('fsm_worker', $$ select count(*) from fsm_core.api_keys $$),
  '42501', 'fsm_worker cannot read fsm_core.api_keys');

select * from finish();
rollback;
