-- Table that persists validated async operation metadata.
-- unique constraint is on (async_operation_name, async_operation_version, async_operation_type, parent_fsm_name, parent_fsm_version)
CREATE TABLE IF NOT EXISTS fsm_core.async_operation_meta (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  async_operation_name    text        NOT NULL,
  async_operation_version text        NOT NULL,
  async_operation_type    text        NOT NULL,
  async_operation_language text        NOT NULL,  
  parent_fsm_name         text        NOT NULL,
  parent_fsm_version      text        NOT NULL,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  constraint async_operation_meta_unique UNIQUE (async_operation_name, async_operation_version, async_operation_type, parent_fsm_name, parent_fsm_version)
);

CREATE OR REPLACE FUNCTION fsm_core.load_async_operation_meta_v2(
  input_async_operation_name    text,
  input_async_operation_version text,
  input_async_operation_type    text,
  input_async_operation_language text,
  input_parent_fsm_name         text,
  input_parent_fsm_version      text

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
    updated_at             = now()
  RETURNING jsonb_build_object(
    'id',                     id,
    'async_operation_name',   async_operation_name,
    'async_operation_version', async_operation_version,
    'async_operation_type',   async_operation_type,
    'async_operation_language', async_operation_language,
    'parent_fsm_name',        parent_fsm_name,
    'parent_fsm_version',     parent_fsm_version,
    'updated_at',             updated_at
  ) INTO v_result;

  RETURN v_result;
END;
$$;
