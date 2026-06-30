-- FSM Scheduler tables
-- fsm_daemon_node: fsmlet node registry — tracks registered fsmlet nodes,
--   their loaded FSM modules, concurrency capacity, and heartbeat.
-- fsm_dispatch_queue: routing table — pending/scheduled dispatch entries
--   written by the API/fsmctl and consumed by the fsmscheduler → fsmlet.

create table if not exists fsm_core.fsm_daemon_node (
  daemon_id        text        primary key,
  fsm_modules      jsonb       not null default '[]',
  max_concurrency  int         not null,
  active_workers   int         not null default 0,
  last_heartbeat   timestamptz not null default now(),
  registered_at    timestamptz not null default now()
);

create table if not exists fsm_core.fsm_dispatch_queue (
  id                  bigserial   primary key,
  instance_id         text        not null,
  fsm_name            text        not null,
  fsm_version         text        not null,
  dispatch_type       text        not null default 'start',  -- 'start' | 'resume'
  status              text        not null default 'pending', -- 'pending' | 'scheduled'
  scheduled_fsmlet_id text        null,
  created_at          timestamptz not null default now(),
  scheduled_at        timestamptz null
);

create index if not exists idx_fsm_dispatch_queue_pending
  on fsm_core.fsm_dispatch_queue (created_at)
  where status = 'pending';

create index if not exists idx_fsm_dispatch_queue_scheduled
  on fsm_core.fsm_dispatch_queue (scheduled_fsmlet_id)
  where status = 'scheduled';
