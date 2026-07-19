begin;
select plan(18);

-- Tier 1: structural
select has_table('fsm_core', 'fsm_dependencies', 'fsm_core.fsm_dependencies exists');
select has_column('fsm_core', 'fsm_dependencies', 'parent_fsm_name', 'has parent_fsm_name column');
select has_column('fsm_core', 'fsm_dependencies', 'parent_fsm_version', 'has parent_fsm_version column');
select has_column('fsm_core', 'fsm_dependencies', 'child_fsm_name', 'has child_fsm_name column');
select has_column('fsm_core', 'fsm_dependencies', 'child_fsm_version', 'has child_fsm_version column');
select col_is_pk('fsm_core', 'fsm_dependencies',
  ARRAY['parent_fsm_name', 'parent_fsm_version', 'child_fsm_name', 'child_fsm_version'],
  'composite PK covers all four columns');
select has_trigger('fsm_core', 'fsm_dependencies', 'enforce_fsm_no_cycles',
  'enforce_fsm_no_cycles trigger exists');
select has_function('fsm_core', 'check_fsm_circular_dependency',
  'fsm_core.check_fsm_circular_dependency() exists');
select has_function('fsm_core', 'insert_fsm_dependencies',
  'fsm_core.insert_fsm_dependencies() exists');

-- Tier 2: behavioral — build a small dependency graph A -> B -> D -> E,
-- then prove the trigger blocks self-loops and cycles, and that the
-- bulk-insert helper is both cycle-safe and idempotent (ON CONFLICT DO NOTHING).
select lives_ok(
  $$ insert into fsm_core.fsm_dependencies values ('A', '1', 'B', '1') $$,
  'valid edge A(1) -> B(1) inserts cleanly'
);
select lives_ok(
  $$ insert into fsm_core.fsm_dependencies values ('B', '1', 'C', '1') $$,
  'valid edge B(1) -> C(1) inserts cleanly'
);
select throws_ok(
  $$ insert into fsm_core.fsm_dependencies values ('A', '1', 'A', '1') $$,
  'P0001',
  'Circular dependency: FSM (A 1) cannot depend on itself.',
  'FSM cannot depend on itself: circular dependency error'
);
select throws_ok(
  $$ insert into fsm_core.fsm_dependencies values ('C', '1', 'A', '1') $$,
  'P0001',
  'Circular dependency: linking (C 1) -> (A 1) creates an infinite loop.',
  'closing the loop C(1) -> A(1) raises a circular dependency error'
);
select lives_ok(
  $$ select fsm_core.insert_fsm_dependencies('D', '1',
       '[{"fsm_name": "E", "fsm_version": "1"}]'::jsonb) $$,
  'insert_fsm_dependencies helper inserts D(1) -> E(1)'
);
select results_eq(
  $$ select count(*) from fsm_core.fsm_dependencies
     where parent_fsm_name = 'D' and child_fsm_name = 'E' $$,
  $$ values (1::bigint) $$,
  'D(1) -> E(1) edge exists exactly once'
);
select lives_ok(
  $$ select fsm_core.insert_fsm_dependencies('D', '1',
       '[{"fsm_name": "E", "fsm_version": "1"}]'::jsonb) $$,
  'repeating the same helper call is a no-op (ON CONFLICT DO NOTHING)'
);
select results_eq(
  $$ select count(*) from fsm_core.fsm_dependencies
     where parent_fsm_name = 'D' and child_fsm_name = 'E' $$,
  $$ values (1::bigint) $$,
  'D(1) -> E(1) edge is still exactly one row after the repeat call'
);
select throws_ok(
  $$ select fsm_core.insert_fsm_dependencies('E', '1',
       '[{"fsm_name": "D", "fsm_version": "1"}]'::jsonb) $$,
  'P0001',
  'Circular dependency: linking (E 1) -> (D 1) creates an infinite loop.',
  'closing a cycle through insert_fsm_dependencies still raises via the trigger'
);

select * from finish();
rollback;
