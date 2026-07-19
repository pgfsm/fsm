begin;
select plan(13);

select has_function('fsm_core', 'load_fsm_state_from_json_v2', ARRAY['jsonb', 'text', 'text', 'text'],
  'load_fsm_state_from_json_v2(jsonb, text, text, text) exists');
select has_function('fsm_core', 'load_fsm_transition_from_json_v2', ARRAY['jsonb', 'text', 'text', 'text'],
  'load_fsm_transition_from_json_v2(jsonb, text, text, text) exists');

-- Isolate from any pre-existing rows for this fsm_name/version in the shared
-- local dev database; the outer rollback restores prior state afterward.
delete from fsm_core.fsm_transitions where fsm_name = 'testFsm' and fsm_version = 'v9';
delete from fsm_core.fsm_states where fsm_name = 'testFsm' and fsm_version = 'v9';

-- A small realistic compound FSM: root "light" with two atomic children
-- "red"/"green", each transitioning to the other on "NEXT". Source/target refs
-- use the "#"-prefixed convention (matching the real XState-derived JSON) so
-- fsm_core.sanitize_text_to_ltree strips the "#" down to the plain state id.
select results_eq(
  $$ select fsm_core.load_fsm_state_from_json_v2(
       '{"id":"light","key":"light","type":"compound","order":-1,"states":{
          "red":{"id":"light.red","key":"red","type":"atomic","order":1,
            "transitions":[{"source":"#light.red","target":["#light.green"],"eventType":"NEXT","actions":[]}]},
          "green":{"id":"light.green","key":"green","type":"atomic","order":2,
            "transitions":[{"source":"#light.green","target":["#light.red"],"eventType":"NEXT","actions":[]}]}
        }}'::jsonb,
       NULL, 'testFsm', 'v9') $$,
  $$ values ('{"ok": true, "fsm_core.fsm_states_count": 3}'::jsonb) $$,
  'loading the fixture inserts the root plus two nested states (3 total calls)'
);
select results_eq(
  $$ select count(*) from fsm_core.fsm_states where fsm_name = 'testFsm' and fsm_version = 'v9' $$,
  $$ values (3::bigint) $$,
  'three rows are actually inserted into fsm_states'
);
select results_eq(
  $$ select parent_node, type from fsm_core.fsm_states
     where fsm_name = 'testFsm' and fsm_version = 'v9' and computed_state_id_ltree = 'light'::ltree $$,
  $$ values (NULL::text, 'compound'::fsm_core.fsm_state_type) $$,
  'the root state has no parent_node and the correct type'
);
select results_eq(
  $$ select parent_node, type, computed_state_key_ltree from fsm_core.fsm_states
     where fsm_name = 'testFsm' and fsm_version = 'v9' and computed_state_id_ltree = 'light.red'::ltree $$,
  $$ values ('light'::text, 'atomic'::fsm_core.fsm_state_type, 'light.red'::ltree) $$,
  'the nested "red" state has parent_node=light and the correct computed key path'
);
select results_eq(
  $$ select parent_node, type, computed_state_key_ltree from fsm_core.fsm_states
     where fsm_name = 'testFsm' and fsm_version = 'v9' and computed_state_id_ltree = 'light.green'::ltree $$,
  $$ values ('light'::text, 'atomic'::fsm_core.fsm_state_type, 'light.green'::ltree) $$,
  'the nested "green" state has parent_node=light and the correct computed key path'
);

-- Transitions can only resolve source/target lookups once the corresponding
-- fsm_states rows exist (as they now do, from the load above).
select results_eq(
  $$ select fsm_core.load_fsm_transition_from_json_v2(
       '{"id":"light","key":"light","type":"compound","order":-1,"states":{
          "red":{"id":"light.red","key":"red","type":"atomic","order":1,
            "transitions":[{"source":"#light.red","target":["#light.green"],"eventType":"NEXT","actions":[]}]},
          "green":{"id":"light.green","key":"green","type":"atomic","order":2,
            "transitions":[{"source":"#light.green","target":["#light.red"],"eventType":"NEXT","actions":[]}]}
        }}'::jsonb,
       NULL, 'testFsm', 'v9') $$,
  $$ values ('{"ok": true, "fsm_core.fsm_transitions_count": 3}'::jsonb) $$,
  'loading transitions recurses through the root plus two nested states (3 total calls)'
);
select results_eq(
  $$ select count(*) from fsm_core.fsm_transitions where fsm_name = 'testFsm' and fsm_version = 'v9' $$,
  $$ values (2::bigint) $$,
  'only the two leaf states contribute an actual transition row (the root has none)'
);
select results_eq(
  $$ select computed_sanitized_source_ltree, computed_sanitized_target_ltree_array, event_type, computed_transition_domain_lca
     from fsm_core.fsm_transitions
     where fsm_name = 'testFsm' and fsm_version = 'v9' and source = '#light.red' $$,
  $$ values ('light.red'::ltree, ARRAY['light.green'::ltree], 'NEXT'::text, 'light'::text) $$,
  'the red->green transition resolves source/target ltrees and the LCA domain correctly'
);
select results_eq(
  $$ select computed_sanitized_source_ltree, computed_sanitized_target_ltree_array, event_type, computed_transition_domain_lca
     from fsm_core.fsm_transitions
     where fsm_name = 'testFsm' and fsm_version = 'v9' and source = '#light.green' $$,
  $$ values ('light.green'::ltree, ARRAY['light.red'::ltree], 'NEXT'::text, 'light'::text) $$,
  'the green->red transition resolves source/target ltrees and the LCA domain correctly'
);

-- Tier 2: invoke validation in load_fsm_state_from_json_v2 — an invoke item
-- with fsmType "fsm" must reference an existing (fsm_name, fsm_version) pair
-- already present in fsm_states, or the whole load is rejected.
select throws_ok(
  $$ select fsm_core.load_fsm_state_from_json_v2(
       '{"id":"invokeTest","key":"invokeTest","type":"atomic","order":-1,
         "invoke":[{"type":"child","id":"childInst","src":"missingChildFsm","fsmType":"fsm","fsmVersion":"v1"}]}'::jsonb,
       NULL, 'invokeTestFsm', 'v1') $$,
  'P0001',
  'Child FSM not found in fsm_core.fsm_states: missingChildFsm, v1',
  'an invoke referencing a non-existent child FSM raises'
);
select lives_ok(
  $$ select fsm_core.load_fsm_state_from_json_v2(
       '{"id":"invokeTest2","key":"invokeTest2","type":"atomic","order":-1,
         "invoke":[{"type":"child","id":"childInst","src":"testFsm","fsmType":"fsm","fsmVersion":"v9"}]}'::jsonb,
       NULL, 'invokeTestFsm2', 'v1') $$,
  'an invoke referencing an existing (fsm_name, fsm_version) pair does not raise'
);

select * from finish();
rollback;
