
DROP TABLE IF EXISTS fsm_core.fsm_instance_queue_event_logs;
create table fsm_core.fsm_instance_queue_event_logs (
    fsm_instance_queue_event_log_id uuid not null primary key default gen_random_uuid(),
    
    fsm_instance_id uuid references fsm_core.fsm_instance,
    fsm_instance_id_fsm_type text,
    fsm_instance_id_fsm_version text,
    fsm_instance_queue_msg_id bigint, -- Message ID from the queue system

    event_name text,
    event_data jsonb,
    event_delay integer,

    -- event_source can be external http request, internal finit state machine event
    -- event_source jsonb, -- e.g., 'system' or workflow_instance_event_logs
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