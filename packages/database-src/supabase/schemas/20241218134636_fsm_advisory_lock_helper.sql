create or replace function fsm_core.pg_try_advisory_lock(key bigint)
returns boolean
language sql
volatile
as $$
  select pg_try_advisory_lock($1);
$$;

create or replace function fsm_core.pg_try_advisory_lock(key1 int, key2 int)
returns boolean
language sql
volatile
as $$
  select pg_try_advisory_lock($1, $2);
$$;

-- 👇 Create wrapper for pg_advisory_unlock
create or replace function fsm_core.pg_advisory_unlock(key bigint)
returns boolean
language sql
volatile
as $$
  select pg_advisory_unlock($1);
$$;

create or replace function fsm_core.pg_advisory_unlock(key1 int, key2 int)
returns boolean
language sql
volatile
as $$
  select pg_advisory_unlock($1, $2);
$$;