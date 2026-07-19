begin;
select plan(6);

select has_function('fsm_core', 'claim_scheduled_for_fsmlet', ARRAY['uuid'],
  'claim_scheduled_for_fsmlet(uuid) exists');

delete from fsm_core.fsm_instance_and_fsm_workerlet;

select results_eq(
  $$ select fsm_core.claim_scheduled_for_fsmlet('11111111-1111-1111-1111-111111111111'::uuid) $$,
  $$ values (null::jsonb) $$,
  'nothing scheduled for this fsmlet: claim returns null'
);

insert into fsm_core.fsm_instance_and_fsm_workerlet
  (fsm_instance_and_fsm_workerlet_id, fsm_instance_id, fsm_workerlet_id, fsm_name, fsm_version, dispatch_type, status, scheduled_at)
values
  ('55555555-5555-5555-5555-555555555555'::uuid, '22222222-2222-2222-2222-222222222222'::uuid,
   '11111111-1111-1111-1111-111111111111'::uuid, 'schedFsm', '1', 'start', 'scheduled', now()),
  ('66666666-6666-6666-6666-666666666666'::uuid, '77777777-7777-7777-7777-777777777777'::uuid,
   '99999999-9999-9999-9999-999999999999'::uuid, 'otherFsm', '1', 'resume', 'scheduled', now());

select results_eq(
  $$ select (fsm_core.claim_scheduled_for_fsmlet('11111111-1111-1111-1111-111111111111'::uuid) ->> 'fsm_instance_id')::uuid $$,
  $$ values ('22222222-2222-2222-2222-222222222222'::uuid) $$,
  'claim returns the row scheduled for this specific fsmlet'
);
select results_eq(
  $$ select count(*) from fsm_core.fsm_instance_and_fsm_workerlet
     where fsm_instance_and_fsm_workerlet_id = '55555555-5555-5555-5555-555555555555'::uuid $$,
  $$ values (0::bigint) $$,
  'the claimed row is deleted (atomic claim-and-remove)'
);
select results_eq(
  $$ select count(*) from fsm_core.fsm_instance_and_fsm_workerlet
     where fsm_instance_and_fsm_workerlet_id = '66666666-6666-6666-6666-666666666666'::uuid $$,
  $$ values (1::bigint) $$,
  'a row scheduled for a different fsmlet is left untouched'
);
select results_eq(
  $$ select fsm_core.claim_scheduled_for_fsmlet('11111111-1111-1111-1111-111111111111'::uuid) $$,
  $$ values (null::jsonb) $$,
  'claiming again for the same fsmlet returns null (already claimed)'
);

select * from finish();
rollback;
