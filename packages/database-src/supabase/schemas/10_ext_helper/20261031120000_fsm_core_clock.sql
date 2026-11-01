-- Clock seams (SPEC-015 §2, #642)
--
-- Every timestamp fsm_core reads goes through these two functions instead of
-- now() / clock_timestamp(), so a deterministic simulator can run the real SQL
-- on virtual time. scripts/check-sql-clock-seams.ts fails CI on a raw call.
--
--   fsm_core.tx_now()    replaces now()              STABLE: one value per transaction
--   fsm_core.wall_now()  replaces clock_timestamp()  VOLATILE: advances within a transaction
--
-- Both return the fsm_core.sim_now GUC instead, when the session sets it AND
-- the login (session_user) is a member of the NOLOGIN role fsm_sim. Any session
-- can SET a custom GUC, and these are read inside SECURITY DEFINER functions,
-- so without the role check a client could shift the database's clock in
-- production (e.g. make every fsmlet's heartbeat look stale to the scheduler).
-- No production login is ever granted fsm_sim. With the GUC unset, the role is
-- never looked up: the cost is one current_setting() call.
--
-- session_user, not current_user: inside a SECURITY DEFINER function
-- current_user is the owner, which is a member of everything it granted.

create or replace function fsm_core.tx_now()
returns timestamptz
language sql
stable
as $$
  select case
    when nullif(current_setting('fsm_core.sim_now', true), '') is null then now()
    when pg_has_role(session_user, 'fsm_sim', 'MEMBER')
      then current_setting('fsm_core.sim_now', true)::timestamptz
    else now()
  end;
$$;

create or replace function fsm_core.wall_now()
returns timestamptz
language sql
volatile
as $$
  select case
    when nullif(current_setting('fsm_core.sim_now', true), '') is null then clock_timestamp()
    when pg_has_role(session_user, 'fsm_sim', 'MEMBER')
      then current_setting('fsm_core.sim_now', true)::timestamptz
    else clock_timestamp()
  end;
$$;
