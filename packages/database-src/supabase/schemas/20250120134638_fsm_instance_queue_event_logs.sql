
create table fsm_core.fsm_instance_queue_event_logs (
    id uuid not null primary key default gen_random_uuid(),
    
    fsm_instance_id uuid references fsm_core.fsm_instance,
    fsm_instance_queue_msg_id bigint, -- Message ID from the queue system

    event_name text,
    event_data jsonb,

    

    -- event_source can be external http request, internal finit state machine event
    event_source jsonb, -- e.g., 'system' or workflow_instance_event_logs
    event_started_at timestamp with time zone default now(),
    event_duration integer DEFAULT NULL,
    -- event_ended_at timestamp with time zone,
    event_finished_at timestamp with time zone DEFAULT now(),

    event_status text, -- e.g., 'success', 'failure', 'canceled'.
    event_output jsonb,
    error_message text -- Optional error message if the event fails



);