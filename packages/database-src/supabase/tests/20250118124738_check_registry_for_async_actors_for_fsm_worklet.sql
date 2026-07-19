begin;
select plan(3);

select has_function('fsm_core', 'check_registry_for_async_actors', ARRAY['jsonb', 'text', 'text'],
  'check_registry_for_async_actors(jsonb, text, text) exists');

delete from fsm_core.async_operation_meta where parent_fsm_name = 'crFsm' and parent_fsm_version = 'v1';

insert into fsm_core.async_operation_meta
  (async_operation_name, async_operation_type, async_operation_version, parent_fsm_name, parent_fsm_version, async_operation_language, updated_by_pid)
values
  ('opA', 'internalAsync', '1', 'crFsm', 'v1', 'python', 'pid1');

select results_eq(
  $$ select fsm_core.check_registry_for_async_actors('[{"src": "opA", "fsmVersion": "1"}]'::jsonb, 'crFsm', 'v1') $$,
  $$ values ('{"fsm_name": "crFsm", "fsm_version": "v1", "missing_actors": [], "all_registered": true}'::jsonb) $$,
  'a registered async actor reports all_registered=true with no missing actors'
);
select results_eq(
  $$ select fsm_core.check_registry_for_async_actors(
       '[{"src": "opA", "fsmVersion": "1"}, {"src": "opMissing", "fsmVersion": "9"}]'::jsonb, 'crFsm', 'v1') $$,
  $$ values ('{"fsm_name": "crFsm", "fsm_version": "v1", "missing_actors": [{"src": "opMissing", "fsmVersion": "9"}], "all_registered": false}'::jsonb) $$,
  'an unregistered async actor is reported in missing_actors and flips all_registered to false'
);

select * from finish();
rollback;
