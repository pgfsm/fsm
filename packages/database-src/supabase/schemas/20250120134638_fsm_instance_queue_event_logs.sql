
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


    -- use 1. event_source or 2. sent_to_parent to determine the source of the event, e.g., external http request, internal finit state machine event, or sent from child queue
    
    -- 1. event_source can be external http request, internal finit state machine event
    -- event_source_type text, -- e.g 'system' or 'fsm'
    -- event_source_queue_id uuid, -- e.g., if event_source_type is 'fsm', this is the fsm_instance_id of the source fsm instance
    -- event_source_queue_event_name text, -- e.g., if event_source_type is 'fsm', this is the event_name to source queue

    -- 2. sent_to_parent
    send_to_parent_queue_id uuid, -- references fsm_core.fsm_instance,
    send_to_parent_queue_id_event_name text,

    execution_started_at timestamp with time zone default now(),
    execution_duration integer DEFAULT NULL,
    -- event_ended_at timestamp with time zone,
    execution_finished_at timestamp with time zone DEFAULT now(),

    event_status text, -- e.g., 'success', 'failure', 'canceled'.
    event_output jsonb,
    error_message text -- Optional error message if the event fails

);