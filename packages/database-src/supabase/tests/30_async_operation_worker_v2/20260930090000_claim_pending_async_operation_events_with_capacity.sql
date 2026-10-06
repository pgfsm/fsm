begin;
select plan(9);

select has_function('fsm_core', 'claim_pending_async_operation_events_with_capacity_v2', ARRAY['jsonb'],
  'claim_pending_async_operation_events_with_capacity_v2(jsonb) exists');

-- One actor identity with a queue holding three messages.
select pgmq.create(fsm_core.compute_async_operation_queue_name_v2(
  'capFsm', 'v01', 'internalAsyncOperation', 'capActor', 'v01', 'go'));
create temp table sent as
select pgmq.send(
  fsm_core.compute_async_operation_queue_name_v2('capFsm', 'v01', 'internalAsyncOperation', 'capActor', 'v01', 'go'),
  jsonb_build_object(
    'eventData', jsonb_build_object('eventPayload', jsonb_build_object('n', n), 'actionType', 'xstate.invoke'),
    'sendToParentQueueId', 'instance-' || n,
    'sendToParentQueueIdEventName', 'event-' || n)) as msg_id
from generate_series(1, 3) n;

create temp table claim_input as
select jsonb_build_object(
  'parent_fsm_name', 'capFsm', 'parent_fsm_version', 'v01',
  'async_operation_type', 'internalAsyncOperation', 'async_operation_name', 'capActor',
  'async_operation_version', 'v01', 'async_operation_language', 'go') as identity;

select results_eq(
  $$ select count(*) from fsm_core.claim_pending_async_operation_events_with_capacity_v2(
       (select jsonb_build_array(identity || '{"qty": 2, "vt_seconds": 60}') from claim_input)) $$,
  $$ values (2::bigint) $$,
  'qty caps how many messages are claimed');

select results_eq(
  $$ select count(*) from fsm_core.claim_pending_async_operation_events_with_capacity_v2(
       (select jsonb_build_array(identity || '{"qty": 5, "vt_seconds": 60}') from claim_input)) $$,
  $$ values (1::bigint) $$,
  'claimed messages stay invisible for vt_seconds, so only the third one is left');

select results_eq(
  $$ select count(*) from fsm_core.claim_pending_async_operation_events_with_capacity_v2(
       (select jsonb_build_array(identity || '{"qty": 0, "vt_seconds": 60}') from claim_input)) $$,
  $$ values (0::bigint) $$,
  'qty 0 claims nothing');

select results_eq(
  $$ select count(*) from fsm_core.claim_pending_async_operation_events_with_capacity_v2(
       jsonb_build_array(jsonb_build_object(
         'parent_fsm_name', 'noQueueFsm', 'parent_fsm_version', 'v01',
         'async_operation_type', 'internalAsyncOperation', 'async_operation_name', 'nobody',
         'async_operation_version', 'v01', 'async_operation_language', 'go',
         'qty', 5, 'vt_seconds', 60))) $$,
  $$ values (0::bigint) $$,
  'an identity without a queue is skipped');

-- Make one message visible again, as an expired visibility timeout would.
select pgmq.set_vt(
  fsm_core.compute_async_operation_queue_name_v2('capFsm', 'v01', 'internalAsyncOperation', 'capActor', 'v01', 'go'),
  (select min(msg_id) from sent), 0);

create temp table redelivered as
select row from fsm_core.claim_pending_async_operation_events_with_capacity_v2(
  (select jsonb_build_array(identity || '{"qty": 5, "vt_seconds": 60}') from claim_input)) row;

select results_eq(
  $$ select count(*) from redelivered $$,
  $$ values (1::bigint) $$,
  'a message whose visibility timeout ended is claimed again');
select results_eq(
  $$ select (row->>'readCount')::int from redelivered $$,
  $$ values (2) $$,
  'readCount counts the second delivery');
select results_eq(
  $$ select row->'input', row->>'instanceId', row->>'eventName' from redelivered $$,
  $$ values ('{"n": 1}'::jsonb, 'instance-1'::text, 'event-1'::text) $$,
  'rows carry the same fields as the old claim function');
select ok(
  (select row ? 'msgId' and row ? 'asyncOperationQueueName' and row ? 'sendToParentQueueIdEventName' from redelivered),
  'rows carry the routing fields archiving needs');

select * from finish();
rollback;
