
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

    -- Where the event came from: 'queue' (sent to the instance's pgmq queue)
    -- or 'internal' (raised by the instance's own microstep onto its internal
    -- event queue, SPEC-010, #519).
    event_source text NOT NULL DEFAULT 'queue' CHECK (event_source IN ('queue', 'internal')),

    execution_started_at timestamp with time zone default now(),
    execution_duration integer DEFAULT NULL,
    -- event_ended_at timestamp with time zone,
    execution_finished_at timestamp with time zone DEFAULT now(),

    event_status text, -- e.g., 'success', 'failure', 'canceled'.
    event_output jsonb,
    error_message text -- Optional error message if the event fails

);