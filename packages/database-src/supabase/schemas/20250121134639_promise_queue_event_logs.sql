create table fsm_core.fsm_promise_queue_event_logs (
    id uuid not null primary key default gen_random_uuid(),
   
    event_name text,
    event_input jsonb,

    promise_queue_name text,
    promise_queue_msg_id bigint, 

    
    send_to_parent_queue_id uuid references fsm_core.fsm_instance,
    send_to_parent_queue_id_msg_id text,

    event_started_at timestamp with time zone default now(),
    event_duration integer DEFAULT NULL,
    -- event_ended_at timestamp with time zone,
    event_finished_at timestamp with time zone DEFAULT now(),

    event_status text, -- e.g., 'success', 'failure', 'canceled'.
    event_output jsonb,
    error_message text -- Optional error message if the event fails



);