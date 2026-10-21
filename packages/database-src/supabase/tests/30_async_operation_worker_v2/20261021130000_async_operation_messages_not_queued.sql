begin;
select plan(5);

select has_function('fsm_core', 'async_operation_messages_not_queued_v2', ARRAY['jsonb'],
  'async_operation_messages_not_queued_v2(jsonb) exists (#538)');

select pgmq.create(queue_name := 'Sweep538_Queue');
select pgmq.send(queue_name := 'Sweep538_Queue', msg := '{"n": 1}'::jsonb);
select pgmq.send(queue_name := 'Sweep538_Queue', msg := '{"n": 2}'::jsonb);
select pgmq.send(queue_name := 'Sweep538_Queue', msg := '{"n": 3}'::jsonb);
-- Message 2's state exited: a cancel archived it.
select fsm_core.finish_async_operation_event_v2('cancelled', 'Sweep538_Queue', 2::bigint);
-- Message 3 is claimed (invisible): still queued.
select count(*) from pgmq.read('Sweep538_Queue', 30, 1);

select results_eq(
  $$ select fsm_core.async_operation_messages_not_queued_v2(
       '[{"queue_name": "Sweep538_Queue", "msg_id": 1}, {"queue_name": "Sweep538_Queue", "msg_id": 2},
         {"queue_name": "Sweep538_Queue", "msg_id": 3}]'::jsonb) $$,
  $$ values ('[{"queue_name": "Sweep538_Queue", "msg_id": 2}]'::jsonb) $$,
  'only the archived message is reported; queued and claimed (invisible) ones are not (#538)'
);
select results_eq(
  $$ select fsm_core.async_operation_messages_not_queued_v2(
       '[{"queue_name": "neverCreated538", "msg_id": 5}]'::jsonb) $$,
  $$ values ('[{"queue_name": "neverCreated538", "msg_id": 5}]'::jsonb) $$,
  'a message of a queue that doesn''t exist counts as gone (#538)'
);
select results_eq(
  $$ select fsm_core.async_operation_messages_not_queued_v2('[]'::jsonb),
            fsm_core.async_operation_messages_not_queued_v2(NULL) $$,
  $$ values ('[]'::jsonb, '[]'::jsonb) $$,
  'no messages: nothing reported (#538)'
);
select ok(
  has_function_privilege('fsm_worker', 'fsm_core.async_operation_messages_not_queued_v2(jsonb)', 'execute')
    and not has_function_privilege('public', 'fsm_core.async_operation_messages_not_queued_v2(jsonb)', 'execute'),
  'the gateway''s role may call it; PUBLIC may not (#538)'
);

select * from finish();
rollback;
