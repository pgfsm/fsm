begin;
select plan(3);

select has_function('fsm_core', 'check_registry_and_working_for_async_actors_for_fsm_instance_and_worklet',
  ARRAY['jsonb', 'text', 'text'],
  'check_registry_and_working_for_async_actors_for_fsm_instance_and_worklet(jsonb, text, text) exists');

delete from fsm_core.async_operation_instance_and_async_operation_workerlet
  where parent_fsm_name = 'crwFsm' and parent_fsm_version = 'v1';

insert into fsm_core.async_operation_instance_and_async_operation_workerlet
  (async_operation_instance_id, async_operation_name, async_operation_version, async_operation_type,
   parent_fsm_name, parent_fsm_version, async_operation_language, status)
values
  (gen_random_uuid(), 'opA', '1', 'internalAsync', 'crwFsm', 'v1', 'python', 'pending');

select results_eq(
  $$ select fsm_core.check_registry_and_working_for_async_actors_for_fsm_instance_and_worklet(
       '[{"src": "opA", "fsmVersion": "1"}]'::jsonb, 'crwFsm', 'v1') $$,
  $$ values ('{"fsm_name": "crwFsm", "fsm_version": "v1", "all_working": true, "non_working_actors": []}'::jsonb) $$,
  'an actor with a pending dispatch row is reported as working'
);
select results_eq(
  $$ select fsm_core.check_registry_and_working_for_async_actors_for_fsm_instance_and_worklet(
       '[{"src": "opA", "fsmVersion": "1"}, {"src": "opGone", "fsmVersion": "1"}]'::jsonb, 'crwFsm', 'v1') $$,
  $$ values ('{"fsm_name": "crwFsm", "fsm_version": "v1", "all_working": false, "non_working_actors": [{"src": "opGone", "fsmVersion": "1"}]}'::jsonb) $$,
  'an actor with no pending/scheduled dispatch row is reported in non_working_actors'
);

select * from finish();
rollback;
