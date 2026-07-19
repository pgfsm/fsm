begin;
select plan(18);

-- Tier 1: structural
select has_function('fsm_core', 'get_initial_actions_v2', ARRAY['text[]', 'text', 'text'],
  'get_initial_actions_v2(text[], text, text) exists');
select has_function('fsm_core', 'get_entry_actions_v2', ARRAY['text[]', 'text', 'text'],
  'get_entry_actions_v2(text[], text, text) exists');
select has_type('fsm_core', 'descendant_states_result_v2', 'descendant_states_result_v2 type exists');
select has_column('fsm_core', 'descendant_states_result_v2', 'descendant_states_to_enter', 'has descendant_states_to_enter field');
select has_column('fsm_core', 'descendant_states_result_v2', 'descendant_states_for_default_entry', 'has descendant_states_for_default_entry field');
select has_function('fsm_core', 'get_descendant_states_for_entry_v2', ARRAY['text', 'text', 'text'],
  'get_descendant_states_for_entry_v2(text, text, text) exists');
select has_type('fsm_core', 'ancestor_states_result_v2', 'ancestor_states_result_v2 type exists');
select has_column('fsm_core', 'ancestor_states_result_v2', 'ancestor_states_to_enter', 'has ancestor_states_to_enter field');
select has_column('fsm_core', 'ancestor_states_result_v2', 'ancestor_states_for_default_entry', 'has ancestor_states_for_default_entry field');
select has_function('fsm_core', 'get_ancestor_states_for_entry_v2', ARRAY['text[]', 'text', 'text', 'text'],
  'get_ancestor_states_for_entry_v2(text[], text, text, text) exists');
select has_function('fsm_core', 'compute_entry_actions_v2', ARRAY['fsm_core.fsm_transitions', 'text', 'text', 'boolean'],
  'compute_entry_actions_v2(fsm_transitions, text, text, boolean) exists');

-- Isolate from any pre-existing rows for this fsm_name/version.
delete from fsm_core.fsm_transitions where fsm_name = 'enact' and fsm_version = 'v1';
delete from fsm_core.fsm_states where fsm_name = 'enact' and fsm_version = 'v1';

-- Fixture: compound root "r" (initial -> c1) with a nested compound child
-- "r.c1" (initial -> its own atomic child "r.c1.a"), plus a sibling atomic "r.c2".
insert into fsm_core.fsm_states
  (state_id_with_fsm_name_and_fsm_version, computed_state_id_ltree, computed_state_key_ltree,
   id, key, parent_node, type, fsm_order, initial, entry, fsm_name, fsm_version)
values
  ('enact.v1.r', 'r', 'r', 'r', 'r', NULL, 'compound', 1,
   '{"target": ["#r.c1"], "source": "#r"}'::jsonb, '[{"type": "enterR"}]'::jsonb, 'enact', 'v1'),
  ('enact.v1.r.c1', 'r.c1', 'r.c1', 'r.c1', 'c1', 'r', 'compound', 2,
   '{"target": ["#r.c1.a"], "source": "#r.c1"}'::jsonb, '[{"type": "enterC1"}]'::jsonb, 'enact', 'v1'),
  ('enact.v1.r.c1.a', 'r.c1.a', 'r.c1.a', 'r.c1.a', 'a', 'r.c1', 'atomic', 3,
   NULL, '[{"type": "enterA"}]'::jsonb, 'enact', 'v1'),
  ('enact.v1.r.c2', 'r.c2', 'r.c2', 'r.c2', 'c2', 'r', 'atomic', 4,
   NULL, '[{"type": "enterC2"}]'::jsonb, 'enact', 'v1');

insert into fsm_core.fsm_transitions
  (source, computed_sanitized_source_ltree, target, computed_sanitized_target_ltree_array,
   event_type, computed_transition_domain_lca, reenter, fsm_name, fsm_version)
values
  ('#r', 'r', ARRAY['#r.c2']::text[], ARRAY['r.c2'::ltree], 'GO_C2', 'r', false, 'enact', 'v1'),
  ('#r', 'r', ARRAY['#r.c1']::text[], ARRAY['r.c1'::ltree], 'GO_C1', 'r', false, 'enact', 'v1');

select results_eq(
  $$ select fsm_core.get_entry_actions_v2(ARRAY['r', 'r.c2'], 'enact', 'v1') $$,
  $$ values ('[
       {"type": "enterC2", "fsm_order": 4, "action_type": "entry", "parentFsmName": "enact", "parentFsmVersion": "v1"},
       {"type": "enterR", "fsm_order": 1, "action_type": "entry", "parentFsmName": "enact", "parentFsmVersion": "v1"}
     ]'::jsonb) $$,
  'collects entry actions from matching states, tagged with fsm_order/parent FSM and ordered DESC'
);
select results_eq(
  $$ select fsm_core.get_initial_actions_v2(ARRAY['r'], 'enact', 'v1') $$,
  $$ values ('[]'::jsonb) $$,
  'a state whose "initial" has no actions array contributes nothing'
);
select results_eq(
  $$ select fsm_core.get_descendant_states_for_entry_v2('r.c1', 'enact', 'v1') $$,
  $$ values (ROW(ARRAY['r.c1.a'], ARRAY['r.c1.a'])::fsm_core.descendant_states_result_v2) $$,
  'a compound state''s descendants resolve through its initial target down to the atomic leaf'
);
select results_eq(
  $$ select fsm_core.compute_entry_actions_v2(
       (select t from fsm_core.fsm_transitions t where event_type = 'GO_C2' and fsm_name = 'enact' and fsm_version = 'v1'),
       'enact', 'v1', false) $$,
  $$ values ('{
       "common_states": ["r.c2"],
       "states_to_enter": ["r.c2"],
       "states_for_default_entry": ["r.c2"],
       "entry_actions_for_states_to_enter": [{"type": "enterC2", "fsm_order": 4, "action_type": "entry", "parentFsmName": "enact", "parentFsmVersion": "v1"}],
       "initial_actions_for_common_states": []
     }'::jsonb) $$,
  'a transition straight to an atomic sibling only enters that one state'
);
select results_eq(
  $$ select fsm_core.compute_entry_actions_v2(
       (select t from fsm_core.fsm_transitions t where event_type = 'GO_C1' and fsm_name = 'enact' and fsm_version = 'v1'),
       'enact', 'v1', false) $$,
  $$ values ('{
       "common_states": ["r.c1", "r.c1.a"],
       "states_to_enter": ["r.c1", "r.c1.a"],
       "states_for_default_entry": ["r.c1", "r.c1.a"],
       "entry_actions_for_states_to_enter": [
         {"type": "enterA", "fsm_order": 3, "action_type": "entry", "parentFsmName": "enact", "parentFsmVersion": "v1"},
         {"type": "enterC1", "fsm_order": 2, "action_type": "entry", "parentFsmName": "enact", "parentFsmVersion": "v1"}
       ],
       "initial_actions_for_common_states": []
     }'::jsonb) $$,
  'a transition to a compound target also enters its initial descendant chain'
);
select results_eq(
  $$ select fsm_core.compute_entry_actions_v2(NULL, 'enact', 'v1', true) $$,
  $$ values ('{
       "common_states": [],
       "states_to_enter": ["r", "r.c1", "r.c1.a"],
       "states_for_default_entry": [],
       "entry_actions_for_states_to_enter": [
         {"type": "enterA", "fsm_order": 3, "action_type": "entry", "parentFsmName": "enact", "parentFsmVersion": "v1"},
         {"type": "enterC1", "fsm_order": 2, "action_type": "entry", "parentFsmName": "enact", "parentFsmVersion": "v1"},
         {"type": "enterR", "fsm_order": 1, "action_type": "entry", "parentFsmName": "enact", "parentFsmVersion": "v1"}
       ],
       "initial_actions_for_common_states": []
     }'::jsonb) $$,
  'an initial transition (no transition record needed) enters the whole default initial-state chain from the root'
);
select results_eq(
  $$ select fsm_core.compute_entry_actions_v2(NULL, 'enact', 'v1', false) $$,
  $$ values ('{"common_states": [], "states_to_enter": [], "states_for_default_entry": [], "entry_actions_for_states_to_enter": [], "initial_actions_for_common_states": []}'::jsonb) $$,
  'a NULL transition record on a non-initial transition yields an all-empty result'
);

select * from finish();
rollback;
