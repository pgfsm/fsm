create table fsm_core.async_operation_workerlet (

  async_operation_workerlet_id uuid not null primary key default gen_random_uuid(),
  async_operation_workerlet_pid    text        NOT NULL,

  supported_async_operations      jsonb       not null default '[]', -- [{"async_operation_name": "myAsyncOp", "async_operation_version": "1.0.0", "parent_fsm_name": "myFSM", "parent_fsm_version": "1.0.0"}, {"async_operation_name": "myAsyncOp", "async_operation_version": "1.0.1", "parent_fsm_name": "myFSM", "parent_fsm_version": "1.0.1"}] ( matching fsm_core.async_operation_meta table )
  
  max_pid_number  int         not null,
  active_pid_number   int         not null default 0,
  
  last_heartbeat   timestamptz not null default now(),
  registered_at    timestamptz not null default now()
  
);