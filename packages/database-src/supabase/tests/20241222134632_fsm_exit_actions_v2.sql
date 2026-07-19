begin;
select plan(10);

select has_function('fsm_core', 'get_exit_actions_v2', ARRAY['text[]', 'text', 'text'],
  'get_exit_actions_v2(text[], text, text) exists');
select has_function('fsm_core', 'compute_child_exit_set_v2', ARRAY['ltree', 'ltree[]'],
  'compute_child_exit_set_v2(ltree, ltree[]) exists');
select has_function('fsm_core', 'compute_full_exit_set_v2', ARRAY['fsm_core.fsm_transitions', 'text[]'],
  'compute_full_exit_set_v2(fsm_transitions, text[]) exists');
select has_function('fsm_core', 'compute_exit_actions_v2', ARRAY['fsm_core.fsm_transitions', 'text[]', 'text', 'text'],
  'compute_exit_actions_v2(fsm_transitions, text[], text, text) exists');

-- Isolate from any pre-existing rows for this fsm_name/version.
delete from fsm_core.fsm_transitions where fsm_name = 'ea' and fsm_version = 'v1';
delete from fsm_core.fsm_states where fsm_name = 'ea' and fsm_version = 'v1';

-- Fixture: root "m" (exit action) with atomic children "m.a" (exit + invoke
-- actions) and "m.b" (no actions).
insert into fsm_core.fsm_states
  (state_id_with_fsm_name_and_fsm_version, computed_state_id_ltree, computed_state_key_ltree,
   id, key, parent_node, type, fsm_order, exit, invoke, fsm_name, fsm_version)
values
  ('ea.v1.m', 'm', 'm', 'm', 'm', NULL, 'compound', 1, '[{"type": "logExitM"}]'::jsonb, '[]'::jsonb, 'ea', 'v1'),
  ('ea.v1.m.a', 'm.a', 'm.a', 'm.a', 'a', 'm', 'atomic', 2, '[{"type": "cleanupA"}]'::jsonb, '[{"type": "stopInvokeA"}]'::jsonb, 'ea', 'v1'),
  ('ea.v1.m.b', 'm.b', 'm.b', 'm.b', 'b', 'm', 'atomic', 3, '[]'::jsonb, '[]'::jsonb, 'ea', 'v1');

-- Two transitions: a reentering self-transition on the root "m" (domain == m),
-- and a non-reentering transition from "m.a" whose domain is also "m".
insert into fsm_core.fsm_transitions
  (source, computed_sanitized_source_ltree, target, computed_sanitized_target_ltree_array,
   event_type, computed_transition_domain_lca, reenter, fsm_name, fsm_version)
values
  ('#m', 'm', ARRAY['#m']::text[], ARRAY['m'::ltree], 'SELF', 'm', true, 'ea', 'v1'),
  ('#m.a', 'm.a', ARRAY['#m.b']::text[], ARRAY['m.b'::ltree], 'LEAVE_A', 'm', false, 'ea', 'v1');

select results_eq(
  $$ select fsm_core.get_exit_actions_v2(ARRAY['m', 'm.a'], 'ea', 'v1') $$,
  $$ values ('{"actions": [
       {"type": "cleanupA", "fsm_order": 2, "action_type": "exit"},
       {"type": "stopInvokeA", "fsm_order": 2, "action_type": "invoke"},
       {"type": "logExitM", "fsm_order": 1, "action_type": "exit"}
     ]}'::jsonb) $$,
  'collects exit and invoke actions from all matching states, tagged and ordered by fsm_order DESC'
);
select results_eq(
  $$ select fsm_core.compute_child_exit_set_v2('m'::ltree, ARRAY['m'::ltree, 'm.a'::ltree, 'm.b'::ltree, 'other'::ltree]) $$,
  $$ values (ARRAY['m', 'm.a', 'm.b']::text[]) $$,
  'keeps only nodes that are the domain itself or its descendants'
);
select results_eq(
  $$ select fsm_core.compute_full_exit_set_v2(
       (select t from fsm_core.fsm_transitions t where event_type = 'SELF' and fsm_name = 'ea' and fsm_version = 'v1'),
       ARRAY['m.a', 'm.b']) $$,
  $$ values (ARRAY['m', 'm.a', 'm.b']::text[]) $$,
  'a reentering self-transition (source == domain) adds the domain itself to the exit set'
);
select results_eq(
  $$ select fsm_core.compute_full_exit_set_v2(
       (select t from fsm_core.fsm_transitions t where event_type = 'LEAVE_A' and fsm_name = 'ea' and fsm_version = 'v1'),
       ARRAY['m.a', 'm.b']) $$,
  $$ values (ARRAY['m.a', 'm.b']::text[]) $$,
  'a non-reentering transition does not add the source itself, only its descendants'
);
select results_eq(
  $$ select fsm_core.compute_exit_actions_v2(
       (select t from fsm_core.fsm_transitions t where event_type = 'SELF' and fsm_name = 'ea' and fsm_version = 'v1'),
       ARRAY['m.a', 'm.b'], 'ea', 'v1') $$,
  $$ values ('{"exit_nodes": ["m", "m.a", "m.b"], "exit_actions": [
       {"type": "cleanupA", "fsm_order": 2, "action_type": "exit"},
       {"type": "stopInvokeA", "fsm_order": 2, "action_type": "invoke"},
       {"type": "logExitM", "fsm_order": 1, "action_type": "exit"}
     ]}'::jsonb) $$,
  'combines the full exit set with its resolved exit/invoke actions'
);
select results_eq(
  $$ select fsm_core.compute_exit_actions_v2(NULL, ARRAY['m.a', 'm.b'], 'ea', 'v1') $$,
  $$ values ('{"exit_nodes": [], "exit_actions": []}'::jsonb) $$,
  'a NULL transition record (no matching transition) yields empty exit nodes and actions'
);

select * from finish();
rollback;
