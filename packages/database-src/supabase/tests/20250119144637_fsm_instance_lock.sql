begin;
select plan(15);

-- Tier 1: structural
select has_table('fsm_core', 'fsm_instance_lock', 'fsm_core.fsm_instance_lock exists');
select col_is_pk('fsm_core', 'fsm_instance_lock', 'fsm_instance_id', 'fsm_instance_id is the primary key');
select fk_ok('fsm_core', 'fsm_instance_lock', 'fsm_instance_id', 'fsm_core', 'fsm_instance', 'id',
  'fsm_instance_id references fsm_core.fsm_instance(id)');
select has_column('fsm_core', 'fsm_instance_lock', 'locked', 'has locked column');
select has_column('fsm_core', 'fsm_instance_lock', 'locked_by', 'has locked_by column');
select has_column('fsm_core', 'fsm_instance_lock', 'locked_at', 'has locked_at column');
select has_column('fsm_core', 'fsm_instance_lock', 'expires_at', 'has expires_at column');
select has_function('fsm_core', 'lock_fsm_instance', ARRAY['uuid', 'text'], 'lock_fsm_instance(uuid, text) exists');
select has_function('fsm_core', 'unlock_fsm_instance', ARRAY['uuid'], 'unlock_fsm_instance(uuid) exists');

-- Tier 2: behavioral — lock_fsm_instance/unlock_fsm_instance actually operate on
-- fsm_core.fsm_instance's own worker_locked* columns (not the fsm_instance_lock
-- table above, which these functions do not touch).
insert into fsm_core.fsm_instance (id, fsm_name, fsm_version)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'lockFsm', 'v1');

select results_eq(
  $$ select fsm_core.lock_fsm_instance('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'pid1') $$,
  $$ values (true) $$,
  'locking a fresh (unlocked) instance succeeds'
);
select results_eq(
  $$ select worker_locked, worker_locked_by from fsm_core.fsm_instance
     where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid $$,
  $$ values (true, 'pid1'::text) $$,
  'the instance row reflects the lock and its owner'
);
select results_eq(
  $$ select fsm_core.lock_fsm_instance('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'pid2') $$,
  $$ values (false) $$,
  'locking an already-locked instance fails'
);
select results_eq(
  $$ select fsm_core.unlock_fsm_instance('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid) $$,
  $$ values (true) $$,
  'unlocking a locked instance succeeds'
);
select results_eq(
  $$ select worker_locked, worker_locked_by from fsm_core.fsm_instance
     where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid $$,
  $$ values (false, NULL::text) $$,
  'the instance row reflects the unlock and clears the owner'
);
select results_eq(
  $$ select fsm_core.unlock_fsm_instance('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid) $$,
  $$ values (false) $$,
  'unlocking an already-unlocked instance fails'
);

select * from finish();
rollback;
