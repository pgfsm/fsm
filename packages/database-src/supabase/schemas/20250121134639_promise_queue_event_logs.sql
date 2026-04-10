DROP TABLE IF EXISTS fsm_core.fsm_promise_queue_event_logs;
create table fsm_core.fsm_promise_queue_event_logs (
    promise_queue_event_log_id uuid not null primary key default gen_random_uuid(),
   
    promise_queue_name text,
    promise_queue_type text,
    promise_queue_version text,
    promise_queue_msg_id bigint, 

    event_name text,
    event_data jsonb,
    event_delay integer,

    
    send_to_parent_queue_id uuid references fsm_core.fsm_instance,
    send_to_parent_queue_id_msg_id text,

    execution_started_at timestamp with time zone default now(),
    execution_duration integer DEFAULT NULL,
    -- event_ended_at timestamp with time zone,
    execution_finished_at timestamp with time zone DEFAULT now(),

    event_status text, -- e.g., 'success', 'failure', 'canceled'.
    event_output jsonb,
    error_message text -- Optional error message if the event fails

);