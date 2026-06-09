CREATE OR REPLACE FUNCTION fsm_core.stop_event_for_fsm_worker_v2(
    input_fsm_instance_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    lock_record fsm_core.fsm_instance_lock%ROWTYPE;
    unlock_result boolean;
    event_log_id uuid;
BEGIN
    -- 1. Check fsm_instance_lock — fetch record regardless of lock state
    SELECT * INTO lock_record
    FROM fsm_core.fsm_instance_lock
    WHERE fsm_instance_id = input_fsm_instance_id;

    -- No lock record exists for this instance
    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'status',           'fsm_not_found',
            'fsm_instance_id',  input_fsm_instance_id,
            'lock_record',      'null'::jsonb
        );
    END IF;

    -- Lock record exists but worker is not running
    IF lock_record.locked IS NOT TRUE THEN
        RETURN jsonb_build_object(
            'status',           'already_stopped',
            'fsm_instance_id',  input_fsm_instance_id,
            'lock_record',      to_jsonb(lock_record)
        );
    END IF;

    -- 2. Unlock via unlock_fsm_instance
    unlock_result := fsm_core.unlock_fsm_instance(
        input_fsm_instance_id := input_fsm_instance_id
    );

    -- 3. pg_notify so the LISTEN connection wakes any live worker
    PERFORM pg_notify('fsm_worker_stop', input_fsm_instance_id::text);

    -- 4. Log to fsm_instance_queue_event_logs
    INSERT INTO fsm_core.fsm_instance_queue_event_logs (
        fsm_instance_id,
        event_name,
        event_status,
        event_data,
        execution_finished_at
    ) VALUES (
        input_fsm_instance_id,
        'stop_worker',
        'stopped',
        jsonb_build_object('triggered_by', 'stop_event_for_fsm_worker_v2'),
        now()
    ) RETURNING fsm_instance_queue_event_log_id INTO event_log_id;

    -- 5. Return
    RETURN jsonb_build_object(
        'status',           'stopped',
        'fsm_instance_id',  input_fsm_instance_id,
        'unlock_result',    unlock_result,
        'event_log_id',     event_log_id,
        'lock_record',      to_jsonb(lock_record)
    );
END;
$$;
