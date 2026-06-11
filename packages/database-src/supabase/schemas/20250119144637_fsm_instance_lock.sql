


create table fsm_core.fsm_instance_lock (
    fsm_instance_id uuid PRIMARY KEY references fsm_core.fsm_instance,
    locked boolean,
    locked_by text,
    locked_at timestamp with time zone default now(),
    expires_at timestamp with time zone
);

-- DO $$
-- DECLARE
--     default_comment text := '{"history": "true", "realtime": "false"}';
-- BEGIN
--     EXECUTE format('COMMENT ON TABLE %I.%I IS %L', 'public', 'fsm_instance_lock', default_comment);
-- END $$;



-- CREATE OR REPLACE FUNCTION fsm_core.lock_fsm_instance(
--     input_fsm_instance_id uuid,
--     input_locked_by text
-- )
-- RETURNS boolean AS $$
-- DECLARE
--     updated_count INTEGER;
-- BEGIN
--     -- Step 1: Check if the fsm_instance_id exists in referenced table
--     IF NOT EXISTS (
--         SELECT 1 FROM fsm_core.fsm_instance WHERE id = input_fsm_instance_id
--     ) THEN
--         RETURN FALSE;  -- Or raise an exception if required
--     END IF;

--     -- Step 2: Try to insert or update lock
--     INSERT INTO fsm_core.fsm_instance_lock (
--         fsm_instance_id, locked, locked_by, locked_at
--     )
--     VALUES (
--         input_fsm_instance_id, TRUE, input_locked_by, now()
--     )
--     ON CONFLICT (fsm_instance_id)
--     DO UPDATE
--     SET locked = TRUE,
--         locked_by = EXCLUDED.locked_by,
--         locked_at = now(),
--         expires_at = NULL
--     WHERE fsm_instance_lock.locked = FALSE;

--     -- Step 3: Check if insert/update actually happened
--     GET DIAGNOSTICS updated_count = ROW_COUNT;

--     RETURN updated_count > 0;
-- END;
-- $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fsm_core.lock_fsm_instance(
    input_fsm_instance_id uuid,
    input_locked_by text
)
RETURNS boolean AS $$
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
$$ LANGUAGE plpgsql;



-- CREATE OR REPLACE FUNCTION fsm_core.unlock_fsm_instance(input_fsm_instance_id uuid)
-- RETURNS boolean AS $$
-- DECLARE
--     updated_count INTEGER;
-- BEGIN
--     -- Try to update the lock to unlock it
--     UPDATE fsm_core.fsm_instance_lock
--     SET locked = FALSE,
--         locked_by = NULL,
--         locked_at = NULL,
--         expires_at = NULL
--     WHERE fsm_instance_id = input_fsm_instance_id
--       AND locked = TRUE;

--     -- Check if the row was updated
--     GET DIAGNOSTICS updated_count = ROW_COUNT;

--     -- If updated_count > 0, it means it was successfully unlocked
--     RETURN updated_count > 0;
-- END;
-- $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fsm_core.unlock_fsm_instance(input_fsm_instance_id uuid)
RETURNS boolean AS $$
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
$$ LANGUAGE plpgsql;
