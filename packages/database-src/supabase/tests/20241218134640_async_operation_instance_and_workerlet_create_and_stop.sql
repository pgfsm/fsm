begin;
select plan(3);

select has_function('fsm_core', 'create_async_operation_instance_and_notify_async_operation_scheduler_work',
  ARRAY['uuid', 'text', 'text', 'text', 'text', 'text', 'text'],
  'create_async_operation_instance_and_notify_async_operation_scheduler_work(7 args) exists');

select lives_ok(
  $$ select fsm_core.create_async_operation_instance_and_notify_async_operation_scheduler_work(
       '33333333-3333-3333-3333-333333333333'::uuid, 'opCreate', '1', 'internalAsync',
       'fsmCreate', '1', 'python') $$,
  'inserts the dispatch row and notifies without error'
);
select results_eq(
  $$ select async_operation_name, async_operation_version, async_operation_type,
            parent_fsm_name, parent_fsm_version, async_operation_language, status
     from fsm_core.async_operation_instance_and_async_operation_workerlet
     where async_operation_instance_id = '33333333-3333-3333-3333-333333333333'::uuid $$,
  $$ values ('opCreate'::text, '1'::text, 'internalAsync'::text, 'fsmCreate'::text, '1'::text, 'python'::text, 'pending'::text) $$,
  'inserted row matches inputs and defaults to pending status'
);

select * from finish();
rollback;
