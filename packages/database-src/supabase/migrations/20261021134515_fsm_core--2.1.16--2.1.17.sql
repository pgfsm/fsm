-- #548: the deprecated wrapper over finish_async_operation_event_v2 (#533).
-- Every caller now calls finish_async_operation_event_v2 directly; its
-- EXECUTE grants go with it.
drop function if exists "fsm_core"."archive_event_from_fsm_async_operation_type_worker_v2"(input_async_operation_queue_name text, input_async_operation_queue_type text, input_async_operation_queue_version text, input_async_operation_queue_msg_id bigint, input_event_name text, input_event_action_type text, input_event_data jsonb, input_event_delay integer, input_send_to_parent_queue_id uuid, input_send_to_parent_queue_id_event_name text, input_execution_started_at timestamp with time zone, input_execution_duration integer, input_execution_finished_at timestamp with time zone, input_event_status text, input_event_output jsonb, input_error_message text);


