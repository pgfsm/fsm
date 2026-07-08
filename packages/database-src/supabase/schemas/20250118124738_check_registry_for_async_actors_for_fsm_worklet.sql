CREATE OR REPLACE FUNCTION fsm_core.check_registry_for_async_actors(
  input_async_actors  jsonb,
  input_fsm_name      text,
  input_fsm_version   text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_actor          record;
  v_missing_actors jsonb := '[]'::jsonb;
  v_found          boolean;
BEGIN
  FOR v_actor IN
    SELECT
      elem->>'src'        AS src,
      elem->>'fsmVersion' AS fsm_version
    FROM jsonb_array_elements(input_async_actors) AS elem
  LOOP
    SELECT EXISTS (
      SELECT 1
      FROM fsm_core.async_operation_meta
      WHERE parent_fsm_name       = input_fsm_name
        AND parent_fsm_version    = input_fsm_version
        AND async_operation_name  = v_actor.src
        AND async_operation_version = v_actor.fsm_version
    ) INTO v_found;

    IF NOT v_found THEN
      v_missing_actors := v_missing_actors || jsonb_build_array(
        jsonb_build_object(
          'src',        v_actor.src,
          'fsmVersion', v_actor.fsm_version
        )
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'all_registered', jsonb_array_length(v_missing_actors) = 0,
    'missing_actors', v_missing_actors,
    'fsm_name',       input_fsm_name,
    'fsm_version',    input_fsm_version
  );
END;
$$;
