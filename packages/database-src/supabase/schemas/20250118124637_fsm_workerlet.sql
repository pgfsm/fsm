-- FSM Scheduler tables
-- fsm_workerlet: fsmlet node registry — tracks registered fsmlet nodes,
--   their loaded FSM modules, concurrency capacity, and heartbeat.


create table if not exists fsm_core.fsm_workerlet (
  fsm_workerlet_id uuid not null primary key default gen_random_uuid(),
  fsm_workerlet_pid    text        NOT NULL,
  fsm_modules      jsonb       not null default '[]', -- [{"fsm_name": "myFSM", "fsm_version": "1.0.0"}, {"fsm_name": "myFSM", "fsm_version": "1.0.1"}] ( matching fsm_core.fsm_json table )
  max_concurrency  int         not null,
  active_workers   int         not null default 0,
  last_heartbeat   timestamptz not null default now(),
  registered_at    timestamptz not null default now()
);
