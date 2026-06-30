-- ─────────────────────────────────────────────────────────────────────────────
-- stop_event_for_fsm_worker_v1  (renamed from the original _v2)
-- Original stop flow: unlock advisory lock + pg_notify 'fsm_worker_stop'.
-- Used by the pgmq / in-process worker model.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fsm_core.stop_event_for_fsm_worker_v1(
    input_fsm_instance_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    instance_row  fsm_core.fsm_instance%ROWTYPE;
    unlock_result boolean;
    event_log_id  uuid;
BEGIN
    -- 1. Fetch instance row (carries worker lock columns)
    SELECT * INTO instance_row
    FROM fsm_core.fsm_instance
    WHERE id = input_fsm_instance_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'status',          'fsm_not_found',
            'fsm_instance_id', input_fsm_instance_id,
            'lock_record',     'null'::jsonb
        );
    END IF;

    -- 2. Worker is not running
    IF instance_row.worker_locked IS NOT TRUE THEN
        RETURN jsonb_build_object(
            'status',          'stopped_or_not_started',
            'fsm_instance_id', input_fsm_instance_id,
            'lock_record',     jsonb_build_object(
                'worker_locked',          instance_row.worker_locked,
                'worker_locked_by',       instance_row.worker_locked_by,
                'worker_locked_at',       instance_row.worker_locked_at,
                'worker_lock_expires_at', instance_row.worker_lock_expires_at
            )
        );
    END IF;

    -- 3. Unlock directly (avoids extra function-call round-trip)
    UPDATE fsm_core.fsm_instance
    SET
        worker_locked          = false,
        worker_locked_by       = NULL,
        worker_locked_at       = NULL,
        worker_lock_expires_at = NULL
    WHERE id = input_fsm_instance_id;
    unlock_result := FOUND;

    -- 4. pg_notify so the LISTEN connection wakes any live worker
    PERFORM pg_notify('fsm_worker_stop', input_fsm_instance_id::text);

    -- 5. Log to fsm_instance_queue_event_logs
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
        jsonb_build_object('triggered_by', 'stop_event_for_fsm_worker_v1'),
        now()
    ) RETURNING fsm_instance_queue_event_log_id INTO event_log_id;

    -- 6. Return
    RETURN jsonb_build_object(
        'status',          'stopped',
        'fsm_instance_id', input_fsm_instance_id,
        'unlock_result',   unlock_result,
        'event_log_id',    event_log_id,
        'lock_record',     jsonb_build_object(
            'worker_locked',          instance_row.worker_locked,
            'worker_locked_by',       instance_row.worker_locked_by,
            'worker_locked_at',       instance_row.worker_locked_at,
            'worker_lock_expires_at', instance_row.worker_lock_expires_at
        )
    );
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- stop_event_for_fsm_worker_v2
-- Scheduler-model stop flow: cancels any pending or scheduled dispatch entry
-- from fsm_dispatch_queue. Does NOT unlock the advisory lock (no lock model)
-- and does NOT pg_notify (no live worker to signal — the entry is cancelled
-- before a fsmlet ever claims it). If the entry was already claimed and is
-- running, the dispatch row no longer exists; this is a no-op for that case.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fsm_core.stop_event_for_fsm_worker_v2(
    input_fsm_instance_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    instance_row    fsm_core.fsm_instance%ROWTYPE;
    cancelled_count int;
    event_log_id    uuid;
BEGIN
    -- 1. Fetch instance row
    SELECT * INTO instance_row
    FROM fsm_core.fsm_instance
    WHERE id = input_fsm_instance_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'status',          'fsm_not_found',
            'fsm_instance_id', input_fsm_instance_id
        );
    END IF;

    -- 2. Guard: nothing to cancel if instance is in a terminal state
    --    (fsm_instance_status can be inspected here if needed in the future)

    -- 3. Cancel any pending or scheduled dispatch entry for this instance.
    DELETE FROM fsm_core.fsm_dispatch_queue
    WHERE instance_id = input_fsm_instance_id::text
      AND status IN ('pending', 'scheduled');
    GET DIAGNOSTICS cancelled_count = ROW_COUNT;

    -- 4. Log
    INSERT INTO fsm_core.fsm_instance_queue_event_logs (
        fsm_instance_id,
        event_name,
        event_status,
        event_data,
        execution_finished_at
    ) VALUES (
        input_fsm_instance_id,
        'stop_worker',
        'cancelled',
        jsonb_build_object(
            'triggered_by',    'stop_event_for_fsm_worker_v2',
            'cancelled_count', cancelled_count
        ),
        now()
    ) RETURNING fsm_instance_queue_event_log_id INTO event_log_id;

    -- 5. Return
    RETURN jsonb_build_object(
        'status',          CASE WHEN cancelled_count > 0 THEN 'cancelled' ELSE 'not_queued' END,
        'fsm_instance_id', input_fsm_instance_id,
        'cancelled_count', cancelled_count,
        'event_log_id',    event_log_id
    );
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- resume_event_for_fsm_worker_v2
-- Scheduler-model resume: looks up fsm_name + fsm_version from fsm_instance,
-- then calls enqueue_fsm_dispatch_v2 to insert a 'resume' entry into
-- fsm_dispatch_queue and notify the fsmscheduler. Replaces the TypeScript
-- getFsmDataResolveStateValue + enqueueDispatch two-call pattern.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fsm_core.resume_event_for_fsm_worker_v2(
    input_fsm_instance_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_fsm_name    text;
    v_fsm_version text;
BEGIN
    SELECT fsm_name, fsm_version
    INTO v_fsm_name, v_fsm_version
    FROM fsm_core.fsm_instance
    WHERE id = input_fsm_instance_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'status',          'fsm_not_found',
            'fsm_instance_id', input_fsm_instance_id
        );
    END IF;

    PERFORM fsm_core.enqueue_fsm_dispatch_v2(
        input_fsm_instance_id::text,
        v_fsm_name,
        v_fsm_version,
        'resume'
    );

    RETURN jsonb_build_object(
        'status',          'queued',
        'fsm_instance_id', input_fsm_instance_id,
        'fsm_name',        v_fsm_name,
        'fsm_version',     v_fsm_version
    );
END;
$$;
