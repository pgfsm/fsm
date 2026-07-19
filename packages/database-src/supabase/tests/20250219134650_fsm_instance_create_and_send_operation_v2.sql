begin;
select plan(11);

select has_function('fsm_core', 'send_event_to_fsm_queue_with_event_logs_v2',
  ARRAY['uuid', 'text', 'text', 'uuid', 'text', 'text', 'text', 'text', 'jsonb', 'integer', 'text', 'jsonb', 'text', 'timestamptz', 'integer', 'timestamptz'],
  'send_event_to_fsm_queue_with_event_logs_v2(...) exists');
select has_function('fsm_core', 'create_fsm_instance_from_name_v2', ARRAY['text', 'text', 'jsonb', 'boolean'],
  'create_fsm_instance_from_name_v2(text, text, jsonb, boolean) exists');

select throws_ok(
  $$ select fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
       NULL, 'FSM', 'v1', gen_random_uuid(), 'sys', 'evt', 'NEXT', 'system', '{}'::jsonb) $$,
  'P0001',
  'fsm_instance_id is NULL',
  'a NULL fsm_instance_id is rejected up front'
);
select throws_ok(
  $$ select fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
       '99999999-1111-2222-3333-444444444444'::uuid, 'FSM', 'v1', gen_random_uuid(), 'sys', 'evt', 'NEXT', 'system', '{}'::jsonb) $$,
  'P0001',
  'pgmq.send failed for queue 99999999-1111-2222-3333-444444444444: relation "pgmq.q_99999999-1111-2222-3333-444444444444" does not exist',
  'sending to a queue that was never created raises a wrapped pgmq error'
);

delete from fsm_core.fsm_instance_queue_event_logs where fsm_instance_id = '99999999-1111-2222-3333-444444444444'::uuid;
delete from fsm_core.fsm_instance where id = '99999999-1111-2222-3333-444444444444'::uuid;
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version)
values ('99999999-1111-2222-3333-444444444444'::uuid, 'sendFsm', 'v1');
select pgmq.create(queue_name := '99999999-1111-2222-3333-444444444444');

select results_eq(
  $$ select (r->>'event_status'), (r->'queue_data'->>'queueId')::uuid, (r->'queue_data'->'eventData'->>'eventType')
     from fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
       '99999999-1111-2222-3333-444444444444'::uuid, 'FSM', 'v1',
       '00000000-0000-0000-0000-000000000000'::uuid, 'POSTGRES_INTERNAL', 'sysEvt',
       'NEXT', 'system', '{"foo": "bar"}'::jsonb) r $$,
  $$ values ('ACTIVE'::text, '99999999-1111-2222-3333-444444444444'::uuid, 'NEXT'::text) $$,
  'a successful send returns ACTIVE status, the queue id, and the event type'
);
select results_eq(
  $$ select fsm_instance_id_fsm_type, fsm_instance_id_fsm_version, event_name, event_data, event_status
     from fsm_core.fsm_instance_queue_event_logs
     where fsm_instance_id = '99999999-1111-2222-3333-444444444444'::uuid $$,
  $$ values ('FSM'::text, 'v1'::text, 'NEXT'::text, '{"foo": "bar"}'::jsonb, 'ACTIVE'::text) $$,
  'a successful send is also logged in fsm_instance_queue_event_logs'
);

select throws_ok(
  $$ select fsm_core.create_fsm_instance_from_name_v2('unknownFsm', 'v9', '{}'::jsonb, false) $$,
  'P0001',
  'FSM with name unknownFsm and version v9 not found in fsm_core.fsm_json',
  'creating an instance of an unregistered FSM raises'
);

delete from fsm_core.fsm_transitions where fsm_name = 'createFsm' and fsm_version = 'v1';
delete from fsm_core.fsm_json where fsm_name = 'createFsm' and fsm_version = 'v1';
insert into fsm_core.fsm_json (fsm_name, fsm_type, fsm_version, fsm_json)
values ('createFsm', 'FSM', 'v1', '{"id": "createFsm"}'::jsonb);
insert into fsm_core.fsm_transitions (source, computed_sanitized_source_ltree, event_type, fsm_name, fsm_version)
values ('#createFsm', 'createFsm', 'NEXT', 'createFsm', 'v1');

select results_eq(
  $$ select (fsm_core.create_fsm_instance_from_name_v2('createFsm', 'v1', '{"foo": "bar"}'::jsonb, false) - 'fsm_instance_id') $$,
  $$ values ('{
       "message": "queue_created is false and no queue is created.",
       "fsm_name": "createFsm", "fsm_version": "v1", "extra_message": null,
       "queue_created": false, "send_event_result": null,
       "fsm_instance_context": {"foo": "bar"}
     }'::jsonb) $$,
  'creating an instance without a queue reports queue_created=false and no send_event_result'
);
select results_eq(
  $$ select count(*) from fsm_core.fsm_instance where fsm_name = 'createFsm' and fsm_version = 'v1' $$,
  $$ values (1::bigint) $$,
  'exactly one fsm_instance row is created'
);
select results_eq(
  $$ select count(*) from fsm_core.fsm_instance_transitions_auth where fsm_name = 'createFsm' and fsm_version = 'v1' $$,
  $$ values (1::bigint) $$,
  'the FSM''s transition is copied into fsm_instance_transitions_auth'
);
select results_eq(
  $$ select count(*) from fsm_core.fsm_instance_and_fsm_workerlet where fsm_name = 'createFsm' and fsm_version = 'v1' $$,
  $$ values (1::bigint) $$,
  'the new instance is enqueued for dispatch'
);

select * from finish();
rollback;
