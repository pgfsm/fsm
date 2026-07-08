-- FSM Scheduler tables
-- fsm_instance_and_fsm_workerlet: association table — links FSM instances to workerlets
--   written by the API/fsmctl and consumed by the fsmscheduler → fsmlet.

create table if not exists fsm_core.fsm_instance_and_fsm_workerlet (


  fsm_instance_and_fsm_workerlet_id uuid not null primary key default gen_random_uuid(),
  
  fsm_instance_id     uuid        not null,
  fsm_workerlet_id    uuid        null,

  fsm_name            text        not null,
  fsm_version         text        not null,
  
  dispatch_type       text        not null default 'start',  -- 'start' | 'resume'
  status              text        not null default 'pending', -- 'pending' | 'scheduled'
  
  
  created_at          timestamptz not null default now(),
  scheduled_at        timestamptz null
  
);

create index if not exists idx_fsm_instance_and_fsm_workerlet_pending
  on fsm_core.fsm_instance_and_fsm_workerlet (created_at)
  where status = 'pending';

create index if not exists idx_fsm_instance_and_fsm_workerlet_scheduled
  on fsm_core.fsm_instance_and_fsm_workerlet (fsm_workerlet_id)
  where status = 'scheduled';
