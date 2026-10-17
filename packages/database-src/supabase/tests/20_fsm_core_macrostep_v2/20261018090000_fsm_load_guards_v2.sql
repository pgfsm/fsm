-- #510: the loader stores a transition's guard (XState v5's `guard`, or `cond`
-- as a fallback), and select_all_transitions_v2 returns candidates in
-- definition order.
begin;
select plan(6);

delete from fsm_core.fsm_transitions where fsm_name = 'lg' and fsm_version = 'v1';
delete from fsm_core.fsm_states where fsm_name = 'lg' and fsm_version = 'v1';

-- "lg.a" handles CHECK three ways, in this order: a named guard, a
-- parameterized guard, then an unguarded fallback; and OLD with a v4 `cond`.
select ok((fsm_core.load_fsm_state_from_json_v2(
  '{"id": "lg", "key": "lg", "type": "compound", "order": 1,
    "initial": {"target": ["#lg.a"], "source": "#lg"},
    "states": {
      "a": {"id": "lg.a", "key": "a", "type": "atomic", "order": 2,
        "transitions": [
          {"eventType": "CHECK", "source": "#lg.a", "target": ["#lg.b"], "actions": [], "guard": "reportFound"},
          {"eventType": "CHECK", "source": "#lg.a", "target": ["#lg.c"], "actions": [], "guard": {"type": "scoreAbove", "params": {"min": 700}}},
          {"eventType": "CHECK", "source": "#lg.a", "target": ["#lg.d"], "actions": []},
          {"eventType": "OLD", "source": "#lg.a", "target": ["#lg.b"], "actions": [], "cond": "legacyGuard"}]},
      "b": {"id": "lg.b", "key": "b", "type": "atomic", "order": 3},
      "c": {"id": "lg.c", "key": "c", "type": "atomic", "order": 4},
      "d": {"id": "lg.d", "key": "d", "type": "atomic", "order": 5}}}'::jsonb,
  NULL, 'lg', 'v1')->>'ok')::boolean, 'the loader loads the states');
select ok((fsm_core.load_fsm_transition_from_json_v2(
  '{"id": "lg", "key": "lg", "type": "compound", "order": 1,
    "initial": {"target": ["#lg.a"], "source": "#lg"},
    "states": {
      "a": {"id": "lg.a", "key": "a", "type": "atomic", "order": 2,
        "transitions": [
          {"eventType": "CHECK", "source": "#lg.a", "target": ["#lg.b"], "actions": [], "guard": "reportFound"},
          {"eventType": "CHECK", "source": "#lg.a", "target": ["#lg.c"], "actions": [], "guard": {"type": "scoreAbove", "params": {"min": 700}}},
          {"eventType": "CHECK", "source": "#lg.a", "target": ["#lg.d"], "actions": []},
          {"eventType": "OLD", "source": "#lg.a", "target": ["#lg.b"], "actions": [], "cond": "legacyGuard"}]},
      "b": {"id": "lg.b", "key": "b", "type": "atomic", "order": 3},
      "c": {"id": "lg.c", "key": "c", "type": "atomic", "order": 4},
      "d": {"id": "lg.d", "key": "d", "type": "atomic", "order": 5}}}'::jsonb,
  NULL, 'lg', 'v1')->>'ok')::boolean, 'the loader loads the transitions');

select results_eq(
  $$ select coalesce(cond::text, 'NULL') from fsm_core.fsm_transitions
     where fsm_name = 'lg' and fsm_version = 'v1' and event_type = 'CHECK' order by id $$,
  $$ values ('"reportFound"'), ('{"type": "scoreAbove", "params": {"min": 700}}'), ('NULL') $$,
  'the loader stores each transition''s guard (a name, or { type, params }); an unguarded one has none'
);
select results_eq(
  $$ select cond from fsm_core.fsm_transitions
     where fsm_name = 'lg' and fsm_version = 'v1' and event_type = 'OLD' $$,
  $$ values ('"legacyGuard"'::jsonb) $$,
  'a v4 `cond` is still read when there is no `guard`'
);
select results_eq(
  $$ select jsonb_path_query_array(fsm_core.select_all_transitions_v2('CHECK', ARRAY['lg', 'lg.a'], 'lg', 'v1'), '$[*].computed_sanitized_target_ltree_array[0]') $$,
  $$ values ('["lg.b", "lg.c", "lg.d"]'::jsonb) $$,
  'select_all_transitions_v2 returns a state''s candidates in definition order'
);
select is(
  (select count(*)::int from fsm_core.fsm_transitions where fsm_name = 'lg' and fsm_version = 'v1'),
  4,
  'every transition is stored'
);

select * from finish();
rollback;
