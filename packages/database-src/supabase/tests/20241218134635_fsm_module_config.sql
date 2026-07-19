begin;
select plan(29);

-- Tier 1: structural — composite types
select has_type('fsm_core', 'fsm_event_data_v2', 'fsm_core.fsm_event_data_v2 type exists');
select has_column('fsm_core', 'fsm_event_data_v2', 'eventType', 'fsm_event_data_v2.eventType exists');
select has_column('fsm_core', 'fsm_event_data_v2', 'eventPayload', 'fsm_event_data_v2.eventPayload exists');
select has_column('fsm_core', 'fsm_event_data_v2', 'actionType', 'fsm_event_data_v2.actionType exists');

select has_type('fsm_core', 'fsm_queue_msg_data_v2', 'fsm_core.fsm_queue_msg_data_v2 type exists');
select has_column('fsm_core', 'fsm_queue_msg_data_v2', 'eventData', 'fsm_queue_msg_data_v2.eventData exists');
select has_column('fsm_core', 'fsm_queue_msg_data_v2', 'queueId', 'fsm_queue_msg_data_v2.queueId exists');
select has_column('fsm_core', 'fsm_queue_msg_data_v2', 'queueType', 'fsm_queue_msg_data_v2.queueType exists');
select has_column('fsm_core', 'fsm_queue_msg_data_v2', 'queueVersion', 'fsm_queue_msg_data_v2.queueVersion exists');
select has_column('fsm_core', 'fsm_queue_msg_data_v2', 'sendToParentQueueId', 'fsm_queue_msg_data_v2.sendToParentQueueId exists');
select has_column('fsm_core', 'fsm_queue_msg_data_v2', 'sendToParentQueueType', 'fsm_queue_msg_data_v2.sendToParentQueueType exists');
select has_column('fsm_core', 'fsm_queue_msg_data_v2', 'sendToParentQueueIdEventName', 'fsm_queue_msg_data_v2.sendToParentQueueIdEventName exists');
select has_column('fsm_core', 'fsm_queue_msg_data_v2', 'queueMsgId', 'fsm_queue_msg_data_v2.queueMsgId exists');
select has_column('fsm_core', 'fsm_queue_msg_data_v2', 'queueMsgDelay', 'fsm_queue_msg_data_v2.queueMsgDelay exists');
select has_column('fsm_core', 'fsm_queue_msg_data_v2', 'queueFnName', 'fsm_queue_msg_data_v2.queueFnName exists');

-- Tier 1: structural — functions
select has_function('fsm_core', 'fsm_json_schema', 'fsm_core.fsm_json_schema() exists');
select has_function('fsm_core', 'pg_system_queue_uuid', 'fsm_core.pg_system_queue_uuid() exists');
select has_function('fsm_core', 'pg_system_queue_type', 'fsm_core.pg_system_queue_type() exists');
select has_function('fsm_core', 'pg_system_event_name', 'fsm_core.pg_system_event_name() exists');
select has_function('fsm_core', 'api_system_queue_uuid', 'fsm_core.api_system_queue_uuid() exists');
select has_function('fsm_core', 'api_system_queue_type', 'fsm_core.api_system_queue_type() exists');
select has_function('fsm_core', 'api_system_event_name', 'fsm_core.api_system_event_name() exists');

-- Tier 2: behavioral — sentinel constants and JSON schema shape
select results_eq(
  $$ select fsm_core.fsm_json_schema() ->> 'type' $$,
  $$ values ('object'::text) $$,
  'fsm_json_schema() top-level "type" is "object"'
);
select results_eq(
  $$ select fsm_core.pg_system_queue_uuid() $$,
  $$ values ('00000000-0000-0000-0000-000000000000'::uuid) $$,
  'pg_system_queue_uuid() is the all-zero sentinel UUID'
);
select results_eq(
  $$ select fsm_core.pg_system_queue_type() $$,
  $$ values ('POSTGRES_INTERNAL'::text) $$,
  'pg_system_queue_type() is POSTGRES_INTERNAL'
);
select results_eq(
  $$ select fsm_core.pg_system_event_name() $$,
  $$ values ('POSTGRES_INTERNAL_EVENT'::text) $$,
  'pg_system_event_name() is POSTGRES_INTERNAL_EVENT'
);
select results_eq(
  $$ select fsm_core.api_system_queue_uuid() $$,
  $$ values ('00000000-0000-0000-0000-000000000001'::uuid) $$,
  'api_system_queue_uuid() is the sentinel UUID ending in 1'
);
select results_eq(
  $$ select fsm_core.api_system_queue_type() $$,
  $$ values ('API_INTERNAL'::text) $$,
  'api_system_queue_type() is API_INTERNAL'
);
select results_eq(
  $$ select fsm_core.api_system_event_name() $$,
  $$ values ('API_INTERNAL_EVENT'::text) $$,
  'api_system_event_name() is API_INTERNAL_EVENT'
);

select * from finish();
rollback;
