-- async_operation_instance_and_async_operation_workerlet: dispatch queue —
-- links async operation instances to workerlets.
-- Written by the API/async-operation-workerlet and consumed by the scheduler → workerlet.

create table if not exists fsm_core.async_operation_instance_and_async_operation_workerlet (

  async_operation_instance_and_async_operation_workerlet_id uuid not null primary key default gen_random_uuid(),

  async_operation_instance_id  uuid not null,
  async_operation_workerlet_id uuid null,          -- null until scheduler assigns

  async_operation_name     text not null,
  async_operation_version  text not null,
  async_operation_type     text not null,
  parent_fsm_name          text not null,
  parent_fsm_version       text not null,
  async_operation_language text not null,

  status       text        not null default 'pending', -- 'pending' | 'scheduled'

  created_at   timestamptz not null default now(),
  scheduled_at timestamptz null

);

create index if not exists idx_async_operation_instance_and_workerlet_pending
  on fsm_core.async_operation_instance_and_async_operation_workerlet (created_at)
  where status = 'pending';

create index if not exists idx_async_operation_instance_and_workerlet_scheduled
  on fsm_core.async_operation_instance_and_async_operation_workerlet (async_operation_workerlet_id)
  where status = 'scheduled';
