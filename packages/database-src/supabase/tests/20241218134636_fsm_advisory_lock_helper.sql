begin;
select plan(11);

-- Tier 1: structural — the four overloaded wrapper functions exist with the
-- expected signatures.
select has_function('fsm_core', 'pg_try_advisory_lock', ARRAY['bigint'],
  'fsm_core.pg_try_advisory_lock(bigint) exists');
select has_function('fsm_core', 'pg_try_advisory_lock', ARRAY['integer', 'integer'],
  'fsm_core.pg_try_advisory_lock(integer, integer) exists');
select has_function('fsm_core', 'pg_advisory_unlock', ARRAY['bigint'],
  'fsm_core.pg_advisory_unlock(bigint) exists');
select has_function('fsm_core', 'pg_advisory_unlock', ARRAY['integer', 'integer'],
  'fsm_core.pg_advisory_unlock(integer, integer) exists');
select function_returns('fsm_core', 'pg_try_advisory_lock', ARRAY['bigint'], 'boolean',
  'pg_try_advisory_lock(bigint) returns boolean');

-- Tier 2: behavioral — the wrappers actually delegate to the underlying
-- advisory lock primitives (acquire/release semantics), not just the name.
select results_eq(
  $$ select fsm_core.pg_try_advisory_lock(123456789::bigint) $$,
  $$ select true $$,
  'bigint-key lock acquires on a fresh key'
);
select results_eq(
  $$ select fsm_core.pg_advisory_unlock(123456789::bigint) $$,
  $$ select true $$,
  'bigint-key unlock succeeds while held'
);
select results_eq(
  $$ select fsm_core.pg_advisory_unlock(123456789::bigint) $$,
  $$ select false $$,
  'bigint-key unlock fails once already released'
);
select results_eq(
  $$ select fsm_core.pg_try_advisory_lock(42, 99) $$,
  $$ select true $$,
  'two-int-key lock acquires on a fresh key'
);
select results_eq(
  $$ select fsm_core.pg_advisory_unlock(42, 99) $$,
  $$ select true $$,
  'two-int-key unlock succeeds while held'
);
select results_eq(
  $$ select fsm_core.pg_advisory_unlock(42, 99) $$,
  $$ select false $$,
  'two-int-key unlock fails once already released'
);

select * from finish();
rollback;
