begin;
select plan(26);

select has_function('fsm_core', 'microstep_v2',
  ARRAY['fsm_core.fsm_transitions', 'text', 'text[]', 'text', 'text'],
  'microstep_v2(fsm_transitions, text, text[], text, text) exists');

-- Isolate from any pre-existing rows for this fsm_name/version.
delete from fsm_core.fsm_transitions where fsm_name = 'ms' and fsm_version = 'v1';
delete from fsm_core.fsm_states where fsm_name = 'ms' and fsm_version = 'v1';
delete from fsm_core.fsm_transitions where fsm_name = 'msd' and fsm_version = 'v1';
delete from fsm_core.fsm_states where fsm_name = 'msd' and fsm_version = 'v1';
delete from fsm_core.fsm_transitions where fsm_name in ('msi', 'msp', 'msq') and fsm_version = 'v1';
delete from fsm_core.fsm_states where fsm_name in ('msi', 'msp', 'msq') and fsm_version = 'v1';
delete from fsm_core.fsm_transitions where fsm_name in ('mdn', 'mdi', 'mdr') and fsm_version = 'v1';
delete from fsm_core.fsm_states where fsm_name in ('mdn', 'mdi', 'mdr') and fsm_version = 'v1';

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
       "exit_actions": [{"type": "exitA", "fsm_order": 2, "action_type": "exit"}],
       "entry_actions": [{"type": "enterB", "fsm_order": 3, "action_type": "entry", "parentFsmName": "ms", "parentFsmVersion": "v1"}],
       "initial_actions": [],
       "transition_actions": [{"type": "doNext"}],
       "updated_state_value": {"r": "b"},
       "updated_state_value_node_set": ["r", "r.b"],
       "done": false, "raised_events": [], "completion_exit_actions": []
     }'::jsonb) $$,
  'a sibling transition exits the source but not the domain (#506), enters the target, and rebuilds the state value'
);
select results_eq(
  $$ select fsm_core.microstep_v2(NULL, 'initialTransition_event', ARRAY[]::text[], 'ms', 'v1') $$,
  $$ values ('{
       "exit_actions": [],
       "entry_actions": [
         {"type": "enterR", "fsm_order": 1, "action_type": "entry", "parentFsmName": "ms", "parentFsmVersion": "v1"},
         {"type": "enterA", "fsm_order": 2, "action_type": "entry", "parentFsmName": "ms", "parentFsmVersion": "v1"}
       ],
       "initial_actions": [],
       "transition_actions": null,
       "updated_state_value": {"r": "a"},
       "updated_state_value_node_set": ["r", "r.a"],
       "done": false, "raised_events": [], "completion_exit_actions": []
     }'::jsonb) $$,
  'the initialTransition_event enters the machine''s default initial-state chain, parents first (#506), with no exits'
);
-- exit_states_v2 and enter_states_v2 are XState's exitStates and enterStates:
-- the active states go from one to the other.
select has_function('fsm_core', 'exit_states_v2',
  ARRAY['fsm_core.fsm_transitions', 'text[]', 'text', 'text'],
  'exit_states_v2(fsm_transitions, text[], text, text) exists');
select has_function('fsm_core', 'enter_states_v2',
  ARRAY['fsm_core.fsm_transitions', 'text[]', 'boolean', 'text', 'text'],
  'enter_states_v2(fsm_transitions, text[], boolean, text, text) exists');
select results_eq(
  $$ select r - 'exit_actions'
     from (select fsm_core.exit_states_v2(
       (select t from fsm_core.fsm_transitions t where event_type = 'NEXT' and fsm_name = 'ms' and fsm_version = 'v1'),
       ARRAY['r', 'r.a'], 'ms', 'v1') as r) s $$,
  $$ values ('{"exit_nodes": ["r.a"], "state_node_set": ["r"]}'::jsonb) $$,
  'exit_states_v2 returns the states exited and removes them from the active states (mutStateNodeSet.delete)'
);
select results_eq(
  $$ select jsonb_build_object('nodes', r->'state_node_set', 'entered', r->'states_to_enter',
            'entry', jsonb_path_query_array(r->'entry_actions', '$[*].type'), 'raised', r->'raised_events', 'done', r->'done')
     from (select fsm_core.enter_states_v2(
       (select t from fsm_core.fsm_transitions t where event_type = 'NEXT' and fsm_name = 'ms' and fsm_version = 'v1'),
       ARRAY['r'], false, 'ms', 'v1') as r) s $$,
  $$ values ('{"nodes": ["r", "r.b"], "entered": ["r.b"], "entry": ["enterB"], "raised": [], "done": false}'::jsonb) $$,
  'enter_states_v2 adds the states entered to the active states, with their entry actions (mutStateNodeSet.add)'
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

-- Fixture msi (#506): compound root "r" (initial -> "r.c", with action initR),
-- compound "r.c" (initial -> "r.c.x", with action initC), atomic "r.c.x", and
-- atomic sibling "r.y". UP targets the source's parent, so its domain is "r"
-- (get_transition_domain_v2; the old longest-common-prefix value was "r.c").
-- TICK has no target.
insert into fsm_core.fsm_states
  (state_id_with_fsm_name_and_fsm_version, computed_state_id_ltree, computed_state_key_ltree,
   id, key, parent_node, type, fsm_order, initial, entry, exit, fsm_name, fsm_version)
values
  ('msi.v1.r', 'r', 'r', 'r', 'r', NULL, 'compound', 1,
   '{"target": ["#r.c"], "source": "#r", "actions": [{"type": "initR"}]}'::jsonb, '[{"type": "enterR"}]'::jsonb, '[{"type": "exitR"}]'::jsonb, 'msi', 'v1'),
  ('msi.v1.r.c', 'r.c', 'r.c', 'r.c', 'c', 'r', 'compound', 2,
   '{"target": ["#r.c.x"], "source": "#r.c", "actions": [{"type": "initC"}]}'::jsonb, '[{"type": "enterC"}]'::jsonb, '[{"type": "exitC"}]'::jsonb, 'msi', 'v1'),
  ('msi.v1.r.c.x', 'r.c.x', 'r.c.x', 'r.c.x', 'x', 'r.c', 'atomic', 3,
   NULL, '[{"type": "enterX"}]'::jsonb, '[{"type": "exitX"}]'::jsonb, 'msi', 'v1'),
  ('msi.v1.r.y', 'r.y', 'r.y', 'r.y', 'y', 'r', 'atomic', 4,
   NULL, '[{"type": "enterY"}]'::jsonb, '[{"type": "exitY"}]'::jsonb, 'msi', 'v1');

insert into fsm_core.fsm_transitions
  (source, computed_sanitized_source_ltree, target, computed_sanitized_target_ltree_array,
   event_type, actions, computed_transition_domain_lca, reenter, fsm_name, fsm_version)
values
  ('#r.y', 'r.y', ARRAY['#r.c']::text[], ARRAY['r.c'::ltree], 'GO', '[]'::jsonb, 'r', false, 'msi', 'v1'),
  ('#r.c.x', 'r.c.x', ARRAY['#r.c']::text[], ARRAY['r.c'::ltree], 'UP', '[]'::jsonb, 'r', false, 'msi', 'v1'),
  ('#r.c.x', 'r.c.x', ARRAY[]::text[], ARRAY[]::ltree[], 'TICK', '[{"type": "tick"}]'::jsonb, 'r.c.x', false, 'msi', 'v1'),
  -- RESTART re-enters from the root: no domain (get_transition_domain_v2 gives NULL).
  ('#r', 'r', ARRAY['#r.y']::text[], ARRAY['r.y'::ltree], 'RESTART', '[]'::jsonb,
   fsm_core.get_transition_domain_v2('r', ARRAY['r.y'::ltree], true, 'msi', 'v1')::text, true, 'msi', 'v1');

select results_eq(
  $$ select jsonb_build_object('entry', jsonb_path_query_array(r->'entry_actions', '$[*].type'), 'initial', jsonb_path_query_array(r->'initial_actions', '$[*].type'))
     from (select fsm_core.microstep_v2(NULL, 'initialTransition_event', ARRAY[]::text[], 'msi', 'v1') as r) s $$,
  $$ values ('{"entry": ["enterR", "enterC", "enterX"], "initial": ["initR", "initC"]}'::jsonb) $$,
  'the initial step returns every entered state''s initial actions, root included, parents first (#506)'
);
select results_eq(
  $$ select jsonb_build_object('entry', jsonb_path_query_array(r->'entry_actions', '$[*].type'), 'initial', r->'initial_actions')
     from (select fsm_core.microstep_v2(
       (select t from fsm_core.fsm_transitions t where event_type = 'GO' and fsm_name = 'msi' and fsm_version = 'v1'),
       'GO', ARRAY['r', 'r.y'], 'msi', 'v1') as r) s $$,
  $$ values ('{"entry": ["enterC", "enterX"], "initial": [{"type": "initC", "fsm_order": 2, "action_type": "initial"}]}'::jsonb) $$,
  'a targeted compound state''s initial actions come back tagged with its fsm_order; the domain is not re-entered (#506)'
);
select results_eq(
  $$ select (r->'exit_actions') || jsonb_build_object('entry', jsonb_path_query_array(r->'entry_actions', '$[*].type'), 'initial', jsonb_path_query_array(r->'initial_actions', '$[*].type'), 'nodes', r->'updated_state_value_node_set')
     from (select fsm_core.microstep_v2(
       (select t from fsm_core.fsm_transitions t where event_type = 'UP' and fsm_name = 'msi' and fsm_version = 'v1'),
       'UP', ARRAY['r', 'r.c', 'r.c.x'], 'msi', 'v1') as r) s $$,
  $$ values ('[{"type": "exitX", "fsm_order": 3, "action_type": "exit"}, {"type": "exitC", "fsm_order": 2, "action_type": "exit"},
             {"entry": ["enterC", "enterX"], "initial": ["initC"], "nodes": ["r", "r.c", "r.c.x"]}]'::jsonb) $$,
  'targeting the source''s parent uses XState''s domain (its parent): the target exits and re-enters (#506)'
);
select results_eq(
  $$ select jsonb_build_object('exit', r->'exit_actions', 'entry', r->'entry_actions', 'actions', r->'transition_actions', 'nodes', r->'updated_state_value_node_set')
     from (select fsm_core.microstep_v2(
       (select t from fsm_core.fsm_transitions t where event_type = 'TICK' and fsm_name = 'msi' and fsm_version = 'v1'),
       'TICK', ARRAY['r', 'r.c', 'r.c.x'], 'msi', 'v1') as r) s $$,
  $$ values ('{"exit": [], "entry": [], "actions": [{"type": "tick"}], "nodes": ["r", "r.c", "r.c.x"]}'::jsonb) $$,
  'a targetless transition only runs its actions: nothing exits or enters (#506)'
);

select results_eq(
  $$ select jsonb_build_object('exit', r->'exit_actions', 'nodes', r->'updated_state_value_node_set')
     from (select fsm_core.microstep_v2(
       (select t from fsm_core.fsm_transitions t where event_type = 'GO' and fsm_name = 'msi' and fsm_version = 'v1'),
       'initialTransition_event', ARRAY['r', 'r.y'], 'msi', 'v1') as r) s $$,
  $$ values ('{"exit": [], "nodes": ["r", "r.c", "r.c.x", "r.y"]}'::jsonb) $$,
  'the initial step exits nothing even when given a transition record (#506)'
);

select results_eq(
  $$ select jsonb_build_object('exit', jsonb_path_query_array(r->'exit_actions', '$[*].type'), 'entry', jsonb_path_query_array(r->'entry_actions', '$[*].type'), 'initial', r->'initial_actions', 'nodes', r->'updated_state_value_node_set')
     from (select fsm_core.microstep_v2(
       (select t from fsm_core.fsm_transitions t where event_type = 'RESTART' and fsm_name = 'msi' and fsm_version = 'v1'),
       'RESTART', ARRAY['r', 'r.c', 'r.c.x'], 'msi', 'v1') as r) s $$,
  $$ values ('{"exit": ["exitX", "exitC", "exitR"], "entry": ["enterR", "enterY"], "initial": [], "nodes": ["r", "r.y"]}'::jsonb) $$,
  'a re-entering transition from the root exits every state and enters the root again (#506)'
);

-- Fixture msp (#506): parallel root "p" with compound regions "p.a" (atomic
-- "a1") and "p.b" (atomic "b1", initial, and "b2"). CROSS goes from one
-- region to the other, so the domain is the parallel state itself.
insert into fsm_core.fsm_states
  (state_id_with_fsm_name_and_fsm_version, computed_state_id_ltree, computed_state_key_ltree,
   id, key, parent_node, type, fsm_order, initial, states, entry, exit, fsm_name, fsm_version)
values
  ('msp.v1.p', 'p', 'p', 'p', 'p', NULL, 'parallel', 1, NULL,
   '{"a": {"id": "p.a", "key": "a"}, "b": {"id": "p.b", "key": "b"}}'::jsonb, '[{"type": "enterP"}]'::jsonb, '[{"type": "exitP"}]'::jsonb, 'msp', 'v1'),
  ('msp.v1.p.a', 'p.a', 'p.a', 'p.a', 'a', 'p', 'compound', 2,
   '{"target": ["#p.a.a1"], "source": "#p.a"}'::jsonb, NULL, '[{"type": "enterA"}]'::jsonb, '[{"type": "exitA"}]'::jsonb, 'msp', 'v1'),
  ('msp.v1.p.a.a1', 'p.a.a1', 'p.a.a1', 'p.a.a1', 'a1', 'p.a', 'atomic', 3,
   NULL, NULL, '[{"type": "enterA1"}]'::jsonb, '[{"type": "exitA1"}]'::jsonb, 'msp', 'v1'),
  ('msp.v1.p.b', 'p.b', 'p.b', 'p.b', 'b', 'p', 'compound', 4,
   '{"target": ["#p.b.b1"], "source": "#p.b"}'::jsonb, NULL, '[{"type": "enterB"}]'::jsonb, '[{"type": "exitB"}]'::jsonb, 'msp', 'v1'),
  ('msp.v1.p.b.b1', 'p.b.b1', 'p.b.b1', 'p.b.b1', 'b1', 'p.b', 'atomic', 5,
   NULL, NULL, '[{"type": "enterB1"}]'::jsonb, '[{"type": "exitB1"}]'::jsonb, 'msp', 'v1'),
  ('msp.v1.p.b.b2', 'p.b.b2', 'p.b.b2', 'p.b.b2', 'b2', 'p.b', 'atomic', 6,
   NULL, NULL, '[{"type": "enterB2"}]'::jsonb, '[{"type": "exitB2"}]'::jsonb, 'msp', 'v1');

insert into fsm_core.fsm_transitions
  (source, computed_sanitized_source_ltree, target, computed_sanitized_target_ltree_array,
   event_type, actions, computed_transition_domain_lca, reenter, fsm_name, fsm_version)
values
  ('#p.a.a1', 'p.a.a1', ARRAY['#p.b.b2']::text[], ARRAY['p.b.b2'::ltree], 'CROSS', '[]'::jsonb, 'p', false, 'msp', 'v1');

select results_eq(
  $$ select jsonb_build_object('exit', jsonb_path_query_array(r->'exit_actions', '$[*].type'), 'entry', jsonb_path_query_array(r->'entry_actions', '$[*].type'))
     from (select fsm_core.microstep_v2(
       (select t from fsm_core.fsm_transitions t where event_type = 'CROSS' and fsm_name = 'msp' and fsm_version = 'v1'),
       'CROSS', ARRAY['p', 'p.a', 'p.a.a1', 'p.b', 'p.b.b1'], 'msp', 'v1') as r) s $$,
  $$ values ('{"exit": ["exitB1", "exitB", "exitA1", "exitA"], "entry": ["enterA", "enterA1", "enterB", "enterB2"]}'::jsonb) $$,
  'a transition across parallel regions exits and re-enters the regions, not the parallel state (#506)'
);

-- TO_REGION targets the sibling region itself, so the ancestors between it and
-- the domain "p" are none: only "p" is passed to get_ancestor_states_for_entry_v2,
-- which is not entered, and its list is empty when the regions are checked.
insert into fsm_core.fsm_transitions
  (source, computed_sanitized_source_ltree, target, computed_sanitized_target_ltree_array,
   event_type, actions, computed_transition_domain_lca, reenter, fsm_name, fsm_version)
values
  ('#p.a.a1', 'p.a.a1', ARRAY['#p.b']::text[], ARRAY['p.b'::ltree], 'TO_REGION', '[]'::jsonb,
   fsm_core.get_transition_domain_v2('p.a.a1', ARRAY['p.b'::ltree], false, 'msp', 'v1')::text, false, 'msp', 'v1');

select results_eq(
  $$ select jsonb_build_object('exit', jsonb_path_query_array(r->'exit_actions', '$[*].type'), 'entry', jsonb_path_query_array(r->'entry_actions', '$[*].type'), 'nodes', r->'updated_state_value_node_set')
     from (select fsm_core.microstep_v2(
       (select t from fsm_core.fsm_transitions t where event_type = 'TO_REGION' and fsm_name = 'msp' and fsm_version = 'v1'),
       'TO_REGION', ARRAY['p', 'p.a', 'p.a.a1', 'p.b', 'p.b.b1'], 'msp', 'v1') as r) s $$,
  $$ values ('{"exit": ["exitB1", "exitB", "exitA1", "exitA"], "entry": ["enterA", "enterA1", "enterB", "enterB1"], "nodes": ["p", "p.a", "p.a.a1", "p.b", "p.b.b1"]}'::jsonb) $$,
  'a transition from one region to its sibling region re-enters both regions at their initial states (#506)'
);

-- Fixture msq (#506): compound root "q" -> parallel "q.p" with compound regions
-- "q.p.a" (initial "q.p.a.c", itself compound with initial "q.p.a.c.x") and
-- "q.p.b" ("b1", initial, and "b2"); "q.p.a", "q.p.a.c" and "q.p.b" have
-- initial actions. JUMP goes from region a to b2 in region b (domain "q.p"), so
-- region a is entered again through its parallel parent.
insert into fsm_core.fsm_states
  (state_id_with_fsm_name_and_fsm_version, computed_state_id_ltree, computed_state_key_ltree,
   id, key, parent_node, type, fsm_order, initial, states, fsm_name, fsm_version)
values
  ('msq.v1.q', 'q', 'q', 'q', 'q', NULL, 'compound', 1, '{"target": ["#q.p"], "source": "#q"}'::jsonb, NULL, 'msq', 'v1'),
  ('msq.v1.q.p', 'q.p', 'q.p', 'q.p', 'p', 'q', 'parallel', 2, NULL,
   '{"a": {"id": "q.p.a", "key": "a"}, "b": {"id": "q.p.b", "key": "b"}}'::jsonb, 'msq', 'v1'),
  ('msq.v1.q.p.a', 'q.p.a', 'q.p.a', 'q.p.a', 'a', 'q.p', 'compound', 3,
   '{"target": ["#q.p.a.c"], "source": "#q.p.a", "actions": [{"type": "initA"}]}'::jsonb, NULL, 'msq', 'v1'),
  ('msq.v1.q.p.a.c', 'q.p.a.c', 'q.p.a.c', 'q.p.a.c', 'c', 'q.p.a', 'compound', 4,
   '{"target": ["#q.p.a.c.x"], "source": "#q.p.a.c", "actions": [{"type": "initAC"}]}'::jsonb, NULL, 'msq', 'v1'),
  ('msq.v1.q.p.a.c.x', 'q.p.a.c.x', 'q.p.a.c.x', 'q.p.a.c.x', 'x', 'q.p.a.c', 'atomic', 5, NULL, NULL, 'msq', 'v1'),
  ('msq.v1.q.p.b', 'q.p.b', 'q.p.b', 'q.p.b', 'b', 'q.p', 'compound', 6,
   '{"target": ["#q.p.b.b1"], "source": "#q.p.b", "actions": [{"type": "initB"}]}'::jsonb, NULL, 'msq', 'v1'),
  ('msq.v1.q.p.b.b1', 'q.p.b.b1', 'q.p.b.b1', 'q.p.b.b1', 'b1', 'q.p.b', 'atomic', 7, NULL, NULL, 'msq', 'v1'),
  ('msq.v1.q.p.b.b2', 'q.p.b.b2', 'q.p.b.b2', 'q.p.b.b2', 'b2', 'q.p.b', 'atomic', 8, NULL, NULL, 'msq', 'v1');

insert into fsm_core.fsm_transitions
  (source, computed_sanitized_source_ltree, target, computed_sanitized_target_ltree_array,
   event_type, actions, computed_transition_domain_lca, reenter, fsm_name, fsm_version)
values
  ('#q.p.a.c.x', 'q.p.a.c.x', ARRAY['#q.p.b.b2']::text[], ARRAY['q.p.b.b2'::ltree], 'JUMP', '[]'::jsonb,
   fsm_core.get_transition_domain_v2('q.p.a.c.x', ARRAY['q.p.b.b2'::ltree], false, 'msq', 'v1')::text, false, 'msq', 'v1');

select results_eq(
  $$ select jsonb_build_object('initial', jsonb_path_query_array(r->'initial_actions', '$[*].type'), 'nodes', r->'updated_state_value_node_set')
     from (select fsm_core.microstep_v2(
       (select t from fsm_core.fsm_transitions t where event_type = 'JUMP' and fsm_name = 'msq' and fsm_version = 'v1'),
       'JUMP', ARRAY['q', 'q.p', 'q.p.a', 'q.p.a.c', 'q.p.a.c.x', 'q.p.b', 'q.p.b.b1'], 'msq', 'v1') as r) s $$,
  $$ values ('{"initial": ["initAC"], "nodes": ["q", "q.p", "q.p.a", "q.p.a.c", "q.p.a.c.x", "q.p.b", "q.p.b.b2"]}'::jsonb) $$,
  'a region entered again through its parallel parent runs its initial state''s initial actions, not its own (#506)'
);

-- SPEC-010 (a), #518: the done.state events a microstep raises, as XState's
-- enterStates does. Fixture mdn: compound root "m" (an invoke, exit exitM)
-- -> parallel "m.w" with region "m.w.a" (a1, final af) and region "m.w.n",
-- itself parallel with regions "m.w.n.x" (x1, final xf) and "m.w.n.y" (y1,
-- final yf); m.w's onDone goes to the top-level final "m.done".
insert into fsm_core.fsm_states
  (state_id_with_fsm_name_and_fsm_version, computed_state_id_ltree, computed_state_key_ltree,
   id, key, parent_node, type, fsm_order, initial, states, exit, invoke, fsm_name, fsm_version)
values
  ('mdn.v1.m', 'm', 'm', 'm', 'm', NULL, 'compound', 1, '{"target": ["#m.w"], "source": "#m"}'::jsonb, NULL,
   '[{"type": "exitM"}]'::jsonb, '[{"type": "xstate.invoke", "id": "m.job", "src": "job"}]'::jsonb, 'mdn', 'v1'),
  ('mdn.v1.m.w', 'm.w', 'm.w', 'm.w', 'w', 'm', 'parallel', 2, NULL,
   '{"a": {"id": "m.w.a", "key": "a"}, "n": {"id": "m.w.n", "key": "n"}}'::jsonb, '[{"type": "exitW"}]'::jsonb, NULL, 'mdn', 'v1'),
  ('mdn.v1.m.w.a', 'm.w.a', 'm.w.a', 'm.w.a', 'a', 'm.w', 'compound', 3, '{"target": ["#m.w.a.a1"], "source": "#m.w.a"}'::jsonb, NULL, NULL, NULL, 'mdn', 'v1'),
  ('mdn.v1.m.w.a.a1', 'm.w.a.a1', 'm.w.a.a1', 'm.w.a.a1', 'a1', 'm.w.a', 'atomic', 4, NULL, NULL, NULL, NULL, 'mdn', 'v1'),
  ('mdn.v1.m.w.a.af', 'm.w.a.af', 'm.w.a.af', 'm.w.a.af', 'af', 'm.w.a', 'final', 5, NULL, NULL, NULL, NULL, 'mdn', 'v1'),
  ('mdn.v1.m.w.n', 'm.w.n', 'm.w.n', 'm.w.n', 'n', 'm.w', 'parallel', 6, NULL,
   '{"x": {"id": "m.w.n.x", "key": "x"}, "y": {"id": "m.w.n.y", "key": "y"}}'::jsonb, NULL, NULL, 'mdn', 'v1'),
  ('mdn.v1.m.w.n.x', 'm.w.n.x', 'm.w.n.x', 'm.w.n.x', 'x', 'm.w.n', 'compound', 7, '{"target": ["#m.w.n.x.x1"], "source": "#m.w.n.x"}'::jsonb, NULL, NULL, NULL, 'mdn', 'v1'),
  ('mdn.v1.m.w.n.x.x1', 'm.w.n.x.x1', 'm.w.n.x.x1', 'm.w.n.x.x1', 'x1', 'm.w.n.x', 'atomic', 8, NULL, NULL, NULL, NULL, 'mdn', 'v1'),
  ('mdn.v1.m.w.n.x.xf', 'm.w.n.x.xf', 'm.w.n.x.xf', 'm.w.n.x.xf', 'xf', 'm.w.n.x', 'final', 9, NULL, NULL, NULL, NULL, 'mdn', 'v1'),
  ('mdn.v1.m.w.n.y', 'm.w.n.y', 'm.w.n.y', 'm.w.n.y', 'y', 'm.w.n', 'compound', 10, '{"target": ["#m.w.n.y.y1"], "source": "#m.w.n.y"}'::jsonb, NULL, NULL, NULL, 'mdn', 'v1'),
  ('mdn.v1.m.w.n.y.y1', 'm.w.n.y.y1', 'm.w.n.y.y1', 'm.w.n.y.y1', 'y1', 'm.w.n.y', 'atomic', 11, NULL, NULL, NULL, NULL, 'mdn', 'v1'),
  ('mdn.v1.m.w.n.y.yf', 'm.w.n.y.yf', 'm.w.n.y.yf', 'm.w.n.y.yf', 'yf', 'm.w.n.y', 'final', 12, NULL, NULL, NULL, NULL, 'mdn', 'v1'),
  ('mdn.v1.m.done', 'm.done', 'm.done', 'm.done', 'done', 'm', 'final', 13, NULL, NULL, NULL, NULL, 'mdn', 'v1');

insert into fsm_core.fsm_transitions
  (source, computed_sanitized_source_ltree, target, computed_sanitized_target_ltree_array,
   event_type, actions, computed_transition_domain_lca, reenter, fsm_name, fsm_version)
values
  ('#m.w.a.a1', 'm.w.a.a1', ARRAY['#m.w.a.af']::text[], ARRAY['m.w.a.af'::ltree], 'A_DONE', '[]'::jsonb,
   fsm_core.get_transition_domain_v2('m.w.a.a1', ARRAY['m.w.a.af'::ltree], false, 'mdn', 'v1')::text, false, 'mdn', 'v1'),
  ('#m.w.n.y.y1', 'm.w.n.y.y1', ARRAY['#m.w.n.y.yf']::text[], ARRAY['m.w.n.y.yf'::ltree], 'Y_DONE', '[]'::jsonb,
   fsm_core.get_transition_domain_v2('m.w.n.y.y1', ARRAY['m.w.n.y.yf'::ltree], false, 'mdn', 'v1')::text, false, 'mdn', 'v1'),
  ('#m.w', 'm.w', ARRAY['#m.done']::text[], ARRAY['m.done'::ltree], 'xstate.done.state.m.w', '[]'::jsonb,
   fsm_core.get_transition_domain_v2('m.w', ARRAY['m.done'::ltree], false, 'mdn', 'v1')::text, false, 'mdn', 'v1');

select results_eq(
  $$ select jsonb_build_object('raised', r->'raised_events', 'done', r->'done')
     from (select fsm_core.microstep_v2(
       (select t from fsm_core.fsm_transitions t where event_type = 'A_DONE' and fsm_name = 'mdn' and fsm_version = 'v1'),
       'A_DONE', ARRAY['m', 'm.w', 'm.w.a', 'm.w.a.a1', 'm.w.n', 'm.w.n.x', 'm.w.n.x.x1', 'm.w.n.y', 'm.w.n.y.y1'], 'mdn', 'v1') as r) s $$,
  $$ values ('{"raised": [{"eventType": "xstate.done.state.m.w.a"}], "done": false}'::jsonb) $$,
  'a final state whose parent is compound raises done.state.<parent>; the parallel state, with a region not final, raises nothing (#518)'
);
select results_eq(
  $$ select jsonb_path_query_array(fsm_core.microstep_v2(
       (select t from fsm_core.fsm_transitions t where event_type = 'Y_DONE' and fsm_name = 'mdn' and fsm_version = 'v1'),
       'Y_DONE', ARRAY['m', 'm.w', 'm.w.a', 'm.w.a.af', 'm.w.n', 'm.w.n.x', 'm.w.n.x.xf', 'm.w.n.y', 'm.w.n.y.y1'], 'mdn', 'v1')->'raised_events', '$[*].eventType') $$,
  $$ values ('["xstate.done.state.m.w.n.y", "xstate.done.state.m.w.n", "xstate.done.state.m.w"]'::jsonb) $$,
  'the last region finishing raises done.state.<region>, then each enclosing parallel state that is now done, nested ones included (#518)'
);
select results_eq(
  $$ select jsonb_path_query_array(fsm_core.microstep_v2(
       (select t from fsm_core.fsm_transitions t where event_type = 'Y_DONE' and fsm_name = 'mdn' and fsm_version = 'v1'),
       'Y_DONE', ARRAY['m', 'm.w', 'm.w.a', 'm.w.a.a1', 'm.w.n', 'm.w.n.x', 'm.w.n.x.xf', 'm.w.n.y', 'm.w.n.y.y1'], 'mdn', 'v1')->'raised_events', '$[*].eventType') $$,
  $$ values ('["xstate.done.state.m.w.n.y", "xstate.done.state.m.w.n"]'::jsonb) $$,
  'the cascade stops at a parallel state with a region that isn''t final (#518)'
);
select results_eq(
  $$ select jsonb_build_object('raised', r->'raised_events', 'done', r->'done',
            'completion', jsonb_path_query_array(r->'completion_exit_actions', '$[*].type'))
     from (select fsm_core.microstep_v2(
       (select t from fsm_core.fsm_transitions t where event_type = 'xstate.done.state.m.w' and fsm_name = 'mdn' and fsm_version = 'v1'),
       'xstate.done.state.m.w', ARRAY['m', 'm.w', 'm.w.a', 'm.w.a.af', 'm.w.n', 'm.w.n.x', 'm.w.n.x.xf', 'm.w.n.y', 'm.w.n.y.yf'], 'mdn', 'v1') as r) s $$,
  $$ values ('{"raised": [{"eventType": "xstate.done.state.m"}], "done": true, "completion": ["exitM", "xstate.invoke"]}'::jsonb) $$,
  'reaching a top-level final state is done, with the remaining states'' exit actions deepest first and their invokes as stops (#518)'
);
select results_eq(
  $$ select r->'completion_exit_actions'
     from (select fsm_core.microstep_v2(
       (select t from fsm_core.fsm_transitions t where event_type = 'A_DONE' and fsm_name = 'mdn' and fsm_version = 'v1'),
       'A_DONE', ARRAY['m', 'm.w', 'm.w.a', 'm.w.a.a1', 'm.w.n', 'm.w.n.x', 'm.w.n.x.x1', 'm.w.n.y', 'm.w.n.y.y1'], 'mdn', 'v1') as r) s $$,
  $$ values ('[]'::jsonb) $$,
  'no completion exit actions while the machine isn''t done'
);

-- Fixture mdi: root "r" -> parallel "r.p" whose regions "r.p.a" and "r.p.b"
-- both start in a final state, so the initial step finishes both regions.
insert into fsm_core.fsm_states
  (state_id_with_fsm_name_and_fsm_version, computed_state_id_ltree, computed_state_key_ltree,
   id, key, parent_node, type, fsm_order, initial, states, fsm_name, fsm_version)
values
  ('mdi.v1.r', 'r', 'r', 'r', 'r', NULL, 'compound', 1, '{"target": ["#r.p"], "source": "#r"}'::jsonb, NULL, 'mdi', 'v1'),
  ('mdi.v1.r.p', 'r.p', 'r.p', 'r.p', 'p', 'r', 'parallel', 2, NULL,
   '{"a": {"id": "r.p.a", "key": "a"}, "b": {"id": "r.p.b", "key": "b"}}'::jsonb, 'mdi', 'v1'),
  ('mdi.v1.r.p.a', 'r.p.a', 'r.p.a', 'r.p.a', 'a', 'r.p', 'compound', 3, '{"target": ["#r.p.a.af"], "source": "#r.p.a"}'::jsonb, NULL, 'mdi', 'v1'),
  ('mdi.v1.r.p.a.af', 'r.p.a.af', 'r.p.a.af', 'r.p.a.af', 'af', 'r.p.a', 'final', 4, NULL, NULL, 'mdi', 'v1'),
  ('mdi.v1.r.p.b', 'r.p.b', 'r.p.b', 'r.p.b', 'b', 'r.p', 'compound', 5, '{"target": ["#r.p.b.bf"], "source": "#r.p.b"}'::jsonb, NULL, 'mdi', 'v1'),
  ('mdi.v1.r.p.b.bf', 'r.p.b.bf', 'r.p.b.bf', 'r.p.b.bf', 'bf', 'r.p.b', 'final', 6, NULL, NULL, 'mdi', 'v1');

select results_eq(
  $$ select jsonb_build_object('raised', jsonb_path_query_array(r->'raised_events', '$[*].eventType'), 'done', r->'done')
     from (select fsm_core.microstep_v2(NULL, 'initialTransition_event', ARRAY[]::text[], 'mdi', 'v1') as r) s $$,
  $$ values ('{"raised": ["xstate.done.state.r.p.a", "xstate.done.state.r.p.b", "xstate.done.state.r.p"], "done": false}'::jsonb) $$,
  'several regions finishing in one microstep raise the parallel state''s done.state once, after the last region''s (#518)'
);

-- Fixture mdr: a parallel root "pr" with regions "pr.a" (a1, final af) and
-- "pr.b" (already final): when the last region finishes, the machine is done.
insert into fsm_core.fsm_states
  (state_id_with_fsm_name_and_fsm_version, computed_state_id_ltree, computed_state_key_ltree,
   id, key, parent_node, type, fsm_order, initial, states, fsm_name, fsm_version)
values
  ('mdr.v1.pr', 'pr', 'pr', 'pr', 'pr', NULL, 'parallel', 1, NULL,
   '{"a": {"id": "pr.a", "key": "a"}, "b": {"id": "pr.b", "key": "b"}}'::jsonb, 'mdr', 'v1'),
  ('mdr.v1.pr.a', 'pr.a', 'pr.a', 'pr.a', 'a', 'pr', 'compound', 2, '{"target": ["#pr.a.a1"], "source": "#pr.a"}'::jsonb, NULL, 'mdr', 'v1'),
  ('mdr.v1.pr.a.a1', 'pr.a.a1', 'pr.a.a1', 'pr.a.a1', 'a1', 'pr.a', 'atomic', 3, NULL, NULL, 'mdr', 'v1'),
  ('mdr.v1.pr.a.af', 'pr.a.af', 'pr.a.af', 'pr.a.af', 'af', 'pr.a', 'final', 4, NULL, NULL, 'mdr', 'v1'),
  ('mdr.v1.pr.b', 'pr.b', 'pr.b', 'pr.b', 'b', 'pr', 'compound', 5, '{"target": ["#pr.b.bf"], "source": "#pr.b"}'::jsonb, NULL, 'mdr', 'v1'),
  ('mdr.v1.pr.b.bf', 'pr.b.bf', 'pr.b.bf', 'pr.b.bf', 'bf', 'pr.b', 'final', 6, NULL, NULL, 'mdr', 'v1');

insert into fsm_core.fsm_transitions
  (source, computed_sanitized_source_ltree, target, computed_sanitized_target_ltree_array,
   event_type, actions, computed_transition_domain_lca, reenter, fsm_name, fsm_version)
values
  ('#pr.a.a1', 'pr.a.a1', ARRAY['#pr.a.af']::text[], ARRAY['pr.a.af'::ltree], 'FIN', '[]'::jsonb,
   fsm_core.get_transition_domain_v2('pr.a.a1', ARRAY['pr.a.af'::ltree], false, 'mdr', 'v1')::text, false, 'mdr', 'v1');

select results_eq(
  $$ select jsonb_build_object('raised', jsonb_path_query_array(r->'raised_events', '$[*].eventType'), 'done', r->'done')
     from (select fsm_core.microstep_v2(
       (select t from fsm_core.fsm_transitions t where event_type = 'FIN' and fsm_name = 'mdr' and fsm_version = 'v1'),
       'FIN', ARRAY['pr', 'pr.a', 'pr.a.a1', 'pr.b', 'pr.b.bf'], 'mdr', 'v1') as r) s $$,
  $$ values ('{"raised": ["xstate.done.state.pr.a", "xstate.done.state.pr"], "done": true}'::jsonb) $$,
  'a parallel root whose regions are all final is done, as in XState (before #518 only a final child of the root was)'
);

select * from finish();
rollback;
