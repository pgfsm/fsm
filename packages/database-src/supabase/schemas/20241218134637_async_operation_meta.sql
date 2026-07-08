-- Table that persists validated async operation metadata.
-- unique constraint is on (async_operation_name, async_operation_version, async_operation_type, parent_fsm_name, parent_fsm_version)
CREATE TABLE IF NOT EXISTS fsm_core.async_operation_meta (
  async_operation_meta_id uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  
  async_operation_name    text        NOT NULL,
  async_operation_type    text        NOT NULL,  -- internalAsync(promise) | sharedAsync(sharedPromise)
  async_operation_version text        NOT NULL,  -- if async_operation_type = internalAsync, value will be from parent_fsm_version
  parent_fsm_name         text        NOT NULL,  -- if async_operation_type = sharedAsync, value will be ROOT_ASYNC_FNS
  parent_fsm_version      text        NOT NULL,
  
  max_concurrency          int         NOT NULL DEFAULT 8,

  async_operation_language text        NOT NULL,
  
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by_pid          text        NOT NULL,

  constraint async_operation_meta_unique UNIQUE (async_operation_name, async_operation_version, async_operation_type, parent_fsm_name, parent_fsm_version)
);

CREATE OR REPLACE FUNCTION fsm_core.load_async_operation_meta_v2(
  input_async_operation_name    text,
  input_async_operation_version text,
  input_async_operation_type    text,
  input_async_operation_language text,
  input_parent_fsm_name         text,
  input_parent_fsm_version      text,
  input_updated_by_pid          text

)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_result jsonb;
BEGIN
  INSERT INTO fsm_core.async_operation_meta (
    async_operation_name,
    async_operation_version,
    async_operation_type,
    async_operation_language,
    parent_fsm_name,
    parent_fsm_version
  ) VALUES (
    input_async_operation_name,
    input_async_operation_version,
    input_async_operation_type,
    input_async_operation_language,
    input_parent_fsm_name,
    input_parent_fsm_version
  )
  ON CONFLICT ON CONSTRAINT async_operation_meta_unique
  DO UPDATE SET
    updated_at             = now(),
    updated_by_pid         = input_updated_by_pid
  RETURNING jsonb_build_object(
    'async_operation_meta_id',async_operation_meta_id,
    'async_operation_name',   async_operation_name,
    'async_operation_version', async_operation_version,
    'async_operation_type',   async_operation_type,
    'async_operation_language', async_operation_language,
    'parent_fsm_name',        parent_fsm_name,
    'parent_fsm_version',     parent_fsm_version,
    'updated_at',             updated_at,
    'updated_by_pid',         updated_by_pid
  ) INTO v_result;

  RETURN v_result;
END;
$$;
