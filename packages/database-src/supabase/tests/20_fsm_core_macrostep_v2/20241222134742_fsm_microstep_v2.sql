begin;
select plan(6);

select has_function('fsm_core', 'microstep_v2',
  ARRAY['fsm_core.fsm_transitions', 'text', 'text[]', 'text', 'text'],
  'microstep_v2(fsm_transitions, text, text[], text, text) exists');

-- Isolate from any pre-existing rows for this fsm_name/version.
delete from fsm_core.fsm_transitions where fsm_name = 'ms' and fsm_version = 'v1';
delete from fsm_core.fsm_states where fsm_name = 'ms' and fsm_version = 'v1';
delete from fsm_core.fsm_transitions where fsm_name = 'msd' and fsm_version = 'v1';
delete from fsm_core.fsm_states where fsm_name = 'msd' and fsm_version = 'v1';

-- Fixture: compound root "r" (initial -> a) with atomic siblings "r.a"/"r.b",
-- each carrying its own entry/exit actions, plus a transition a -> b; and a
-- top-level final state "r.c" reached from a by FINISH (#500).
insert into fsm_core.fsm_states
  (state_id_with_fsm_name_and_fsm_version, computed_state_id_ltree, computed_state_key_ltree,
   id, key, parent_node, type, fsm_order, initial, entry, exit, fsm_name, fsm_version)
values
  ('ms.v1.r', 'r', 'r', 'r', 'r', NULL, 'compound', 1,
   '{"target": ["#r.a"], "source": "#r"}'::jsonb, '[{"type": "enterR"}]'::jsonb, '[{"type": "exitR"}]'::jsonb, 'ms', 'v1'),
  ('ms.v1.r.a', 'r.a', 'r.a', 'r.a', 'a', 'r', 'atomic', 2,
   NULL, '[{"type": "enterA"}]'::jsonb, '[{"type": "exitA"}]'::jsonb, 'ms', 'v1'),
  ('ms.v1.r.b', 'r.b', 'r.b', 'r.b', 'b', 'r', 'atomic', 3,
   NULL, '[{"type": "enterB"}]'::jsonb, '[{"type": "exitB"}]'::jsonb, 'ms', 'v1'),
  ('ms.v1.r.c', 'r.c', 'r.c', 'r.c', 'c', 'r', 'final', 4,
   NULL, '[]'::jsonb, '[]'::jsonb, 'ms', 'v1');

insert into fsm_core.fsm_transitions
  (source, computed_sanitized_source_ltree, target, computed_sanitized_target_ltree_array,
   event_type, actions, computed_transition_domain_lca, reenter, fsm_name, fsm_version)
values
  ('#r.a', 'r.a', ARRAY['#r.b']::text[], ARRAY['r.b'::ltree], 'NEXT', '[{"type": "doNext"}]'::jsonb, 'r', false, 'ms', 'v1'),
  ('#r.a', 'r.a', ARRAY['#r.c']::text[], ARRAY['r.c'::ltree], 'FINISH', '[]'::jsonb, 'r', false, 'ms', 'v1');

select results_eq(
  $$ select fsm_core.microstep_v2(
       (select t from fsm_core.fsm_transitions t where event_type = 'NEXT' and fsm_name = 'ms' and fsm_version = 'v1'),
       'NEXT', ARRAY['r', 'r.a'], 'ms', 'v1') $$,
  $$ values ('{
       "exit_actions": [{"type": "exitA", "fsm_order": 2, "action_type": "exit"}, {"type": "exitR", "fsm_order": 1, "action_type": "exit"}],
       "entry_actions": [{"type": "enterB", "fsm_order": 3, "action_type": "entry", "parentFsmName": "ms", "parentFsmVersion": "v1"}],
       "initial_actions": [],
       "transition_actions": [{"type": "doNext"}],
       "updated_state_value": {"r": "b"},
       "updated_state_value_node_set": ["r.b"],
       "done": false
     }'::jsonb) $$,
  'a normal transition exits the old node set, enters the target, and rebuilds the state value'
);
select results_eq(
  $$ select fsm_core.microstep_v2(NULL, 'initialTransition_event', ARRAY[]::text[], 'ms', 'v1') $$,
  $$ values ('{
       "exit_actions": [],
       "entry_actions": [
         {"type": "enterA", "fsm_order": 2, "action_type": "entry", "parentFsmName": "ms", "parentFsmVersion": "v1"},
         {"type": "enterR", "fsm_order": 1, "action_type": "entry", "parentFsmName": "ms", "parentFsmVersion": "v1"}
       ],
       "initial_actions": [],
       "transition_actions": null,
       "updated_state_value": {"r": "a"},
       "updated_state_value_node_set": ["r", "r.a"],
       "done": false
     }'::jsonb) $$,
  'the initialTransition_event enters the machine''s default initial-state chain with no exits'
);
select results_eq(
  $$ select (fsm_core.microstep_v2(
       (select t from fsm_core.fsm_transitions t where event_type = 'FINISH' and fsm_name = 'ms' and fsm_version = 'v1'),
       'FINISH', ARRAY['r', 'r.a'], 'ms', 'v1'))->'done' $$,
  $$ values ('true'::jsonb) $$,
  'entering a top-level final state reports done (#500)'
);

-- Fixture msd: a root id with dots ("com.acme.m", three ltree labels), with
-- an atomic "a", a top-level final "end", and a compound "p" holding a
-- nested final "f". done follows the root by parent_node, not by depth.
insert into fsm_core.fsm_states
  (state_id_with_fsm_name_and_fsm_version, computed_state_id_ltree, computed_state_key_ltree,
   id, key, parent_node, type, fsm_order, initial, entry, exit, fsm_name, fsm_version)
values
  ('msd.v1.com.acme.m', 'com.acme.m', 'com.acme.m', 'com.acme.m', 'com.acme.m', NULL, 'compound', 1,
   '{"target": ["#com.acme.m.a"], "source": "#com.acme.m"}'::jsonb, '[]'::jsonb, '[]'::jsonb, 'msd', 'v1'),
  ('msd.v1.com.acme.m.a', 'com.acme.m.a', 'com.acme.m.a', 'com.acme.m.a', 'a', 'com.acme.m', 'atomic', 2,
   NULL, '[]'::jsonb, '[]'::jsonb, 'msd', 'v1'),
  ('msd.v1.com.acme.m.end', 'com.acme.m.end', 'com.acme.m.end', 'com.acme.m.end', 'end', 'com.acme.m', 'final', 3,
   NULL, '[]'::jsonb, '[]'::jsonb, 'msd', 'v1'),
  ('msd.v1.com.acme.m.p', 'com.acme.m.p', 'com.acme.m.p', 'com.acme.m.p', 'p', 'com.acme.m', 'compound', 4,
   '{"target": ["#com.acme.m.p.f"], "source": "#com.acme.m.p"}'::jsonb, '[]'::jsonb, '[]'::jsonb, 'msd', 'v1'),
  ('msd.v1.com.acme.m.p.f', 'com.acme.m.p.f', 'com.acme.m.p.f', 'com.acme.m.p.f', 'f', 'com.acme.m.p', 'final', 5,
   NULL, '[]'::jsonb, '[]'::jsonb, 'msd', 'v1');

insert into fsm_core.fsm_transitions
  (source, computed_sanitized_source_ltree, target, computed_sanitized_target_ltree_array,
   event_type, actions, computed_transition_domain_lca, reenter, fsm_name, fsm_version)
values
  ('#com.acme.m.a', 'com.acme.m.a', ARRAY['#com.acme.m.end']::text[], ARRAY['com.acme.m.end'::ltree], 'FINISH', '[]'::jsonb, 'com.acme.m', false, 'msd', 'v1'),
  ('#com.acme.m.a', 'com.acme.m.a', ARRAY['#com.acme.m.p.f']::text[], ARRAY['com.acme.m.p.f'::ltree], 'DEEP', '[]'::jsonb, 'com.acme.m', false, 'msd', 'v1');

select results_eq(
  $$ select (fsm_core.microstep_v2(
       (select t from fsm_core.fsm_transitions t where event_type = 'FINISH' and fsm_name = 'msd' and fsm_version = 'v1'),
       'FINISH', ARRAY['com.acme.m', 'com.acme.m.a'], 'msd', 'v1'))->'done' $$,
  $$ values ('true'::jsonb) $$,
  'a final child of a root whose id has dots reports done (#500)'
);
select results_eq(
  $$ select (fsm_core.microstep_v2(
       (select t from fsm_core.fsm_transitions t where event_type = 'DEEP' and fsm_name = 'msd' and fsm_version = 'v1'),
       'DEEP', ARRAY['com.acme.m', 'com.acme.m.a'], 'msd', 'v1'))->'done' $$,
  $$ values ('false'::jsonb) $$,
  'a nested final state only finishes its parent, not the machine'
);

select * from finish();
rollback;
