begin;
select plan(11);

select has_function('fsm_core', 'select_transitions_with_guard_eval_v2', ARRAY['fsm_core.fsm_transitions[]'],
  'select_transitions_with_guard_eval_v2(fsm_transitions[]) exists');
select has_function('fsm_core', 'select_all_transitions_v2', ARRAY['text', 'text[]', 'text', 'text'],
  'select_all_transitions_v2(text, text[], text, text) exists');
select has_function('fsm_core', 'macrostep_v2', ARRAY['text', 'text[]', 'text', 'text'],
  'macrostep_v2(text, text[], text, text) exists');
select has_function('fsm_core', 'fsm_worker_v2', ARRAY['text', 'jsonb', 'text', 'text'],
  'fsm_worker_v2(text, jsonb, text, text) exists');

-- Isolate from any pre-existing rows for this fsm_name/version.
delete from fsm_core.fsm_transitions where fsm_name = 'ms' and fsm_version = 'v1';
delete from fsm_core.fsm_states where fsm_name = 'ms' and fsm_version = 'v1';

-- Fixture: same compound root "r" (initial -> a) with atomic siblings
-- "r.a"/"r.b" used in the microstep tests, plus:
--   NEXT       - a single unambiguous transition
--   GUARDED    - two candidates for the same event/source, disambiguated by cond.value
--   AMBIGUOUS  - two candidates that both pass guard evaluation (unresolved conflict)
insert into fsm_core.fsm_states
  (state_id_with_fsm_name_and_fsm_version, computed_state_id_ltree, computed_state_key_ltree,
   id, key, parent_node, type, fsm_order, initial, entry, exit, fsm_name, fsm_version)
values
  ('ms.v1.r', 'r', 'r', 'r', 'r', NULL, 'compound', 1,
   '{"target": ["#r.a"], "source": "#r"}'::jsonb, '[{"type": "enterR"}]'::jsonb, '[{"type": "exitR"}]'::jsonb, 'ms', 'v1'),
  ('ms.v1.r.a', 'r.a', 'r.a', 'r.a', 'a', 'r', 'atomic', 2,
   NULL, '[{"type": "enterA"}]'::jsonb, '[{"type": "exitA"}]'::jsonb, 'ms', 'v1'),
  ('ms.v1.r.b', 'r.b', 'r.b', 'r.b', 'b', 'r', 'atomic', 3,
   NULL, '[{"type": "enterB"}]'::jsonb, '[{"type": "exitB"}]'::jsonb, 'ms', 'v1');

insert into fsm_core.fsm_transitions
  (source, computed_sanitized_source_ltree, target, computed_sanitized_target_ltree_array,
   event_type, actions, cond, computed_transition_domain_lca, reenter, fsm_name, fsm_version)
values
  ('#r.a', 'r.a', ARRAY['#r.b']::text[], ARRAY['r.b'::ltree], 'NEXT', '[{"type": "doNext"}]'::jsonb, NULL, 'r', false, 'ms', 'v1'),
  ('#r.a', 'r.a', ARRAY['#r.b']::text[], ARRAY['r.b'::ltree], 'GUARDED', '[{"type": "doGuardedTrue"}]'::jsonb, '{"value": true}'::jsonb, 'r', false, 'ms', 'v1'),
  ('#r.a', 'r.a', ARRAY['#r.b']::text[], ARRAY['r.b'::ltree], 'GUARDED', '[{"type": "doGuardedFalse"}]'::jsonb, '{"value": false}'::jsonb, 'r', false, 'ms', 'v1'),
  ('#r.a', 'r.a', ARRAY['#r.b']::text[], ARRAY['r.b'::ltree], 'AMBIGUOUS', '[{"type": "a1"}]'::jsonb, NULL, 'r', false, 'ms', 'v1'),
  ('#r.a', 'r.a', ARRAY['#r.b']::text[], ARRAY['r.b'::ltree], 'AMBIGUOUS', '[{"type": "a2"}]'::jsonb, NULL, 'r', false, 'ms', 'v1');

select results_eq(
  $$ select jsonb_array_length(fsm_core.select_all_transitions_v2('NEXT', ARRAY['r.a'], 'ms', 'v1')) $$,
  $$ values (1) $$,
  'select_all_transitions_v2 finds the single matching transition by event/source'
);
select results_eq(
  $$ select fsm_core.select_all_transitions_v2('MISSING', ARRAY['r.a'], 'ms', 'v1') $$,
  $$ values ('[]'::jsonb) $$,
  'select_all_transitions_v2 returns an empty array when nothing matches'
);
select results_eq(
  $$ select fsm_core.macrostep_v2('NEXT', ARRAY['r', 'r.a'], 'ms', 'v1') $$,
  $$ values ('{
       "exit_actions": [{"type": "exitA", "fsm_order": 2, "action_type": "exit"}, {"type": "exitR", "fsm_order": 1, "action_type": "exit"}],
       "entry_actions": [{"type": "enterB", "fsm_order": 3, "action_type": "entry", "parentFsmName": "ms", "parentFsmVersion": "v1"}],
       "initial_actions": [],
       "transition_actions": [{"type": "doNext"}],
       "updated_state_value": {"r": "b"},
       "updated_state_value_node_set": ["r.b"]
     }'::jsonb) $$,
  'a single unambiguous transition runs straight through to microstep_v2'
);
select results_eq(
  $$ select fsm_core.macrostep_v2('GUARDED', ARRAY['r', 'r.a'], 'ms', 'v1') $$,
  $$ values ('{
       "exit_actions": [{"type": "exitA", "fsm_order": 2, "action_type": "exit"}, {"type": "exitR", "fsm_order": 1, "action_type": "exit"}],
       "entry_actions": [{"type": "enterB", "fsm_order": 3, "action_type": "entry", "parentFsmName": "ms", "parentFsmVersion": "v1"}],
       "initial_actions": [],
       "transition_actions": [{"type": "doGuardedTrue"}],
       "updated_state_value": {"r": "b"},
       "updated_state_value_node_set": ["r.b"]
     }'::jsonb) $$,
  'guard evaluation narrows two same-event candidates down to the one with cond.value = true'
);
select throws_ok(
  $$ select fsm_core.macrostep_v2('MISSING', ARRAY['r', 'r.a'], 'ms', 'v1') $$,
  'P0001',
  'No valid transitions found for event_name=MISSING, fsm_name=ms, fsm_version=v1',
  'an event with no matching transition raises'
);
select throws_ok(
  $$ select fsm_core.macrostep_v2('AMBIGUOUS', ARRAY['r', 'r.a'], 'ms', 'v1') $$,
  'P0001',
  'Multiple valid transitions found after guard evaluation for event_name=AMBIGUOUS, fsm_name=ms, fsm_version=v1',
  'two candidates that both pass guard evaluation raise an unresolved-conflict error'
);
select results_eq(
  $$ select fsm_core.fsm_worker_v2('initialTransition_event', '{}'::jsonb, 'ms', 'v1') $$,
  $$ values ('{
       "exit_actions": [],
       "entry_actions": [
         {"type": "enterA", "fsm_order": 2, "action_type": "entry", "parentFsmName": "ms", "parentFsmVersion": "v1"},
         {"type": "enterR", "fsm_order": 1, "action_type": "entry", "parentFsmName": "ms", "parentFsmVersion": "v1"}
       ],
       "initial_actions": [],
       "transition_actions": null,
       "updated_state_value": {"r": "a"},
       "updated_state_value_node_set": ["r", "r.a"]
     }'::jsonb) $$,
  'fsm_worker_v2 resolves the current state value and drives the initial transition end to end'
);

select * from finish();
rollback;
