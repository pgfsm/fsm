alter table "fsm_core"."fsm_instance" add column "worker_lock_expires_at" timestamp with time zone;

alter table "fsm_core"."fsm_instance" add column "worker_locked" boolean default false;

alter table "fsm_core"."fsm_instance" add column "worker_locked_at" timestamp with time zone;

alter table "fsm_core"."fsm_instance" add column "worker_locked_by" text;

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.lock_fsm_instance(input_fsm_instance_id uuid, input_locked_by text)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
    updated_count INTEGER;
BEGIN
    UPDATE fsm_core.fsm_instance
    SET
        worker_locked          = TRUE,
        worker_locked_by       = input_locked_by,
        worker_locked_at       = now(),
        worker_lock_expires_at = NULL
    WHERE id = input_fsm_instance_id
      AND (worker_locked = FALSE OR worker_locked IS NULL);

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count > 0;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.stop_event_for_fsm_worker_v2(input_fsm_instance_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
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

    -- 3. Unlock : TODO directly update here instead of calling unlock_fsm_instance function to save a query, since we have the instance_row already
    unlock_result := fsm_core.unlock_fsm_instance(
        input_fsm_instance_id := input_fsm_instance_id
    );

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
        jsonb_build_object('triggered_by', 'stop_event_for_fsm_worker_v2'),
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
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.unlock_fsm_instance(input_fsm_instance_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
    updated_count INTEGER;
BEGIN
    UPDATE fsm_core.fsm_instance
    SET
        worker_locked          = FALSE,
        worker_locked_by       = NULL,
        worker_locked_at       = NULL,
        worker_lock_expires_at = NULL
    WHERE id = input_fsm_instance_id
      AND worker_locked = TRUE;

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count > 0;
END;
$function$
;


