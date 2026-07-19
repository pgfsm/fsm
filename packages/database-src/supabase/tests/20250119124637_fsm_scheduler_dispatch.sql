begin;
select plan(3);

-- Note: fsm_core.enqueue_fsm_dispatch_v1 is intentionally not tested here —
-- the schema file itself marks it "NOT USED — superseded by v2, preserved for
-- historical reference only".
select has_function('fsm_core', 'enqueue_fsm_dispatch_v2', ARRAY['uuid', 'text', 'text', 'text'],
  'enqueue_fsm_dispatch_v2(uuid, text, text, text) exists');

delete from fsm_core.fsm_instance_and_fsm_workerlet where fsm_name = 'dispatchFsm' and fsm_version = 'v1';

select lives_ok(
  $$ select fsm_core.enqueue_fsm_dispatch_v2(
       '88888888-8888-8888-8888-888888888888'::uuid, 'dispatchFsm', 'v1', 'start') $$,
  'inserts the dispatch row and notifies without error'
);
select results_eq(
  $$ select fsm_name, fsm_version, dispatch_type, status from fsm_core.fsm_instance_and_fsm_workerlet
     where fsm_instance_id = '88888888-8888-8888-8888-888888888888'::uuid $$,
  $$ values ('dispatchFsm'::text, 'v1'::text, 'start'::text, 'pending'::text) $$,
  'inserted row matches inputs and defaults to pending status'
);

select * from finish();
rollback;
