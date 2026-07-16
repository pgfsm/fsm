set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.create_async_operation_instance_and_notify_async_operation_sche(input_async_operation_instance_id uuid, input_async_operation_name text, input_async_operation_version text, input_async_operation_type text, input_parent_fsm_name text, input_parent_fsm_version text, input_async_operation_language text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO fsm_core.async_operation_instance_and_async_operation_workerlet (
    async_operation_instance_id,
    async_operation_name,
    async_operation_version,
    async_operation_type,
    parent_fsm_name,
    parent_fsm_version,
    async_operation_language
  )
  VALUES (
    input_async_operation_instance_id,
    input_async_operation_name,
    input_async_operation_version,
    input_async_operation_type,
    input_parent_fsm_name,
    input_parent_fsm_version,
    input_async_operation_language
  );

  PERFORM pg_notify(
    'async_operation_scheduler_work',
    input_async_operation_instance_id::text
  );
END;
$function$
;


