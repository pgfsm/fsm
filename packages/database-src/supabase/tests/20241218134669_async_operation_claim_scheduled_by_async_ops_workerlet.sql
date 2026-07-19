begin;
select plan(6);

select has_function('fsm_core', 'claim_scheduled_for_async_operation_workerlet', ARRAY['uuid'],
  'claim_scheduled_for_async_operation_workerlet(uuid) exists');

delete from fsm_core.async_operation_instance_and_async_operation_workerlet;

select results_eq(
  $$ select fsm_core.claim_scheduled_for_async_operation_workerlet('11111111-1111-1111-1111-111111111111'::uuid) $$,
  $$ values (null::jsonb) $$,
  'nothing scheduled for this workerlet: claim returns null'
);

insert into fsm_core.async_operation_instance_and_async_operation_workerlet
  (async_operation_instance_and_async_operation_workerlet_id, async_operation_instance_id,
   async_operation_workerlet_id, async_operation_name, async_operation_version,
   async_operation_type, parent_fsm_name, parent_fsm_version, async_operation_language, status, scheduled_at)
values
  ('55555555-5555-5555-5555-555555555555'::uuid, '22222222-2222-2222-2222-222222222222'::uuid,
   '11111111-1111-1111-1111-111111111111'::uuid, 'opY', '1', 'internalAsync', 'fsmY', '1', 'python', 'scheduled', now()),
  ('66666666-6666-6666-6666-666666666666'::uuid, '77777777-7777-7777-7777-777777777777'::uuid,
   '99999999-9999-9999-9999-999999999999'::uuid, 'opZ', '1', 'internalAsync', 'fsmZ', '1', 'python', 'scheduled', now());

select results_eq(
  $$ select (fsm_core.claim_scheduled_for_async_operation_workerlet('11111111-1111-1111-1111-111111111111'::uuid) ->> 'async_operation_instance_id')::uuid $$,
  $$ values ('22222222-2222-2222-2222-222222222222'::uuid) $$,
  'claim returns the row scheduled for this specific workerlet'
);
select results_eq(
  $$ select count(*) from fsm_core.async_operation_instance_and_async_operation_workerlet
     where async_operation_instance_and_async_operation_workerlet_id = '55555555-5555-5555-5555-555555555555'::uuid $$,
  $$ values (0::bigint) $$,
  'the claimed row is deleted (atomic claim-and-remove)'
);
select results_eq(
  $$ select count(*) from fsm_core.async_operation_instance_and_async_operation_workerlet
     where async_operation_instance_and_async_operation_workerlet_id = '66666666-6666-6666-6666-666666666666'::uuid $$,
  $$ values (1::bigint) $$,
  'a row scheduled for a different workerlet is left untouched'
);
select results_eq(
  $$ select fsm_core.claim_scheduled_for_async_operation_workerlet('11111111-1111-1111-1111-111111111111'::uuid) $$,
  $$ values (null::jsonb) $$,
  'claiming again for the same workerlet returns null (already claimed)'
);

select * from finish();
rollback;
