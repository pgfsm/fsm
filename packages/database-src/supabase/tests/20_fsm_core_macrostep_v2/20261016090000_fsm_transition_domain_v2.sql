-- get_transition_domain_v2: XState's getTransitionDomain, stored by the loader
-- in fsm_transitions.computed_transition_domain_lca, and
-- find_least_common_ancestor_v2, its findLeastCommonAncestor (#506).
begin;
select plan(23);

select has_function('fsm_core', 'get_transition_domain_v2', ARRAY['ltree', 'ltree[]', 'boolean', 'text', 'text'],
  'get_transition_domain_v2(ltree, ltree[], boolean, text, text) exists');
select has_function('fsm_core', 'find_least_common_ancestor_v2', ARRAY['ltree[]', 'text', 'text'],
  'find_least_common_ancestor_v2(ltree[], text, text) exists');

delete from fsm_core.fsm_states where fsm_name in ('td', 'tdd', 'tdk', 'tdl') and fsm_version = 'v1';
delete from fsm_core.fsm_transitions where fsm_name = 'tdl' and fsm_version = 'v1';

-- Fixture td: compound root "r" with atomic "r.a", "r.b" and compound "r.c"
-- (atomic "r.c.x", "r.c.y"). Fixture tdd: a root id with dots, "com.acme.m",
-- with atomic "com.acme.m.a".
insert into fsm_core.fsm_states
  (state_id_with_fsm_name_and_fsm_version, computed_state_id_ltree, computed_state_key_ltree,
   id, key, parent_node, type, fsm_order, fsm_name, fsm_version)
values
  ('td.v1.r', 'r', 'r', 'r', 'r', NULL, 'compound', 1, 'td', 'v1'),
  ('td.v1.r.a', 'r.a', 'r.a', 'r.a', 'a', 'r', 'atomic', 2, 'td', 'v1'),
  ('td.v1.r.b', 'r.b', 'r.b', 'r.b', 'b', 'r', 'atomic', 3, 'td', 'v1'),
  ('td.v1.r.c', 'r.c', 'r.c', 'r.c', 'c', 'r', 'compound', 4, 'td', 'v1'),
  ('td.v1.r.c.x', 'r.c.x', 'r.c.x', 'r.c.x', 'x', 'r.c', 'atomic', 5, 'td', 'v1'),
  ('td.v1.r.c.y', 'r.c.y', 'r.c.y', 'r.c.y', 'y', 'r.c', 'atomic', 6, 'td', 'v1'),
  ('tdd.v1.com.acme.m', 'com.acme.m', 'com.acme.m', 'com.acme.m', 'com.acme.m', NULL, 'compound', 1, 'tdd', 'v1'),
  ('tdd.v1.com.acme.m.a', 'com.acme.m.a', 'com.acme.m.a', 'com.acme.m.a', 'a', 'com.acme.m', 'atomic', 2, 'tdd', 'v1'),
  -- Fixture tdk: state keys with a dot ("s3.1", "s3.2") under compound "k.p",
  -- so the path prefix k.p.s3 is no state.
  ('tdk.v1.k', 'k', 'k', 'k', 'k', NULL, 'compound', 1, 'tdk', 'v1'),
  ('tdk.v1.k.p', 'k.p', 'k.p', 'k.p', 'p', 'k', 'compound', 2, 'tdk', 'v1'),
  ('tdk.v1.k.p.s3.1', 'k.p.s3.1', 'k.p.s3.1', 'k.p.s3.1', 's3.1', 'k.p', 'atomic', 3, 'tdk', 'v1'),
  ('tdk.v1.k.p.s3.2', 'k.p.s3.2', 'k.p.s3.2', 'k.p.s3.2', 's3.2', 'k.p', 'atomic', 4, 'tdk', 'v1');

-- find_least_common_ancestor_v2: always a proper ancestor that is a state.
select is(fsm_core.find_least_common_ancestor_v2(ARRAY['r.a', 'r.b']::ltree[], 'td', 'v1'), 'r'::ltree,
  'LCA of siblings: their parent');
select is(fsm_core.find_least_common_ancestor_v2(ARRAY['r.c.x', 'r.c']::ltree[], 'td', 'v1'), 'r'::ltree,
  'LCA when one path is an ancestor of the other: a proper ancestor (sql_lca_from_array gives r.c)');
select is(fsm_core.find_least_common_ancestor_v2(ARRAY['r.a', 'r.a']::ltree[], 'td', 'v1'), 'r'::ltree,
  'LCA of a path with itself: its parent (sql_lca_from_array gives r.a)');
select is(fsm_core.find_least_common_ancestor_v2(ARRAY['r.c.x', 'r.c.y']::ltree[], 'td', 'v1'), 'r.c'::ltree,
  'LCA of cousins under a compound: that compound');
select is(fsm_core.find_least_common_ancestor_v2(ARRAY['r.a', 'r']::ltree[], 'td', 'v1'), NULL::ltree,
  'LCA when one path is the root: none');
select is(fsm_core.find_least_common_ancestor_v2(ARRAY['com.acme.m.a', 'com.acme.m']::ltree[], 'tdd', 'v1'), NULL::ltree,
  'LCA with a root id with dots: none (ltree''s lca() gives com.acme, which is no state)');
select is(fsm_core.find_least_common_ancestor_v2(ARRAY['k.p.s3.1', 'k.p.s3.2']::ltree[], 'tdk', 'v1'), 'k.p'::ltree,
  'LCA of states whose keys have dots: their real parent (ltree''s lca() gives k.p.s3, which is no state)');

select is(fsm_core.get_transition_domain_v2('r.a', ARRAY['r.b'::ltree], false, 'td', 'v1'), 'r'::ltree,
  'siblings: their parent');
select is(fsm_core.get_transition_domain_v2('r.c', ARRAY['r.c.y'::ltree], false, 'td', 'v1'), 'r.c'::ltree,
  'a target inside the source: the source itself');
select is(fsm_core.get_transition_domain_v2('r.c', ARRAY['r.c.y'::ltree], true, 'td', 'v1'), 'r'::ltree,
  'a target inside the source with reenter: the source''s parent');
select is(fsm_core.get_transition_domain_v2('r.c.x', ARRAY['r.c'::ltree], false, 'td', 'v1'), 'r'::ltree,
  'a target that is an ancestor of the source: the target''s parent, not the target');
select is(fsm_core.get_transition_domain_v2('r.a', ARRAY['r.a'::ltree], false, 'td', 'v1'), 'r.a'::ltree,
  'a self-transition: the source');
select is(fsm_core.get_transition_domain_v2('r.a', ARRAY['r.a'::ltree], true, 'td', 'v1'), 'r'::ltree,
  'a re-entering self-transition: the source''s parent');
select is(fsm_core.get_transition_domain_v2('r.a', ARRAY['r'::ltree], false, 'td', 'v1'), 'r'::ltree,
  'targeting the root: the root');
select is(fsm_core.get_transition_domain_v2('r.a', ARRAY['r'::ltree], true, 'td', 'v1'), NULL::ltree,
  'targeting the root with reenter: no domain (every active state exits)');
select is(fsm_core.get_transition_domain_v2('r.c.x', ARRAY[]::ltree[], false, 'td', 'v1'), 'r.c.x'::ltree,
  'a targetless transition: the source');
select is(fsm_core.get_transition_domain_v2('com.acme.m.a', ARRAY['com.acme.m'::ltree], false, 'tdd', 'v1'), 'com.acme.m'::ltree,
  'a root id with dots: the root state, not its first label');
select is(fsm_core.get_transition_domain_v2('r.a', ARRAY['r.b'::ltree], false, 'no-such-fsm', 'v1'), NULL::ltree,
  'only the given FSM version''s states are searched');

-- The loader stores it: UP goes from "tdl.c.x" to its parent "tdl.c".
select ok((fsm_core.load_fsm_state_from_json_v2(
  '{"id": "tdl", "key": "tdl", "type": "compound", "order": 1,
    "initial": {"target": ["#tdl.c"], "source": "#tdl"},
    "states": {"c": {"id": "tdl.c", "key": "c", "type": "compound", "order": 2,
      "initial": {"target": ["#tdl.c.x"], "source": "#tdl.c"},
      "states": {"x": {"id": "tdl.c.x", "key": "x", "type": "atomic", "order": 3,
        "transitions": [{"eventType": "UP", "source": "#tdl.c.x", "target": ["#tdl.c"], "actions": []}]}}}}}'::jsonb,
  NULL, 'tdl', 'v1')->>'ok')::boolean, 'the loader loads the states');
select ok((fsm_core.load_fsm_transition_from_json_v2(
  '{"id": "tdl", "key": "tdl", "type": "compound", "order": 1,
    "initial": {"target": ["#tdl.c"], "source": "#tdl"},
    "states": {"c": {"id": "tdl.c", "key": "c", "type": "compound", "order": 2,
      "initial": {"target": ["#tdl.c.x"], "source": "#tdl.c"},
      "states": {"x": {"id": "tdl.c.x", "key": "x", "type": "atomic", "order": 3,
        "transitions": [{"eventType": "UP", "source": "#tdl.c.x", "target": ["#tdl.c"], "actions": []}]}}}}}'::jsonb,
  NULL, 'tdl', 'v1')->>'ok')::boolean, 'the loader loads the transitions');
select results_eq(
  $$ select computed_transition_domain_lca from fsm_core.fsm_transitions
     where fsm_name = 'tdl' and fsm_version = 'v1' and event_type = 'UP' $$,
  $$ values ('tdl'::text) $$,
  'the loader stores XState''s domain (the longest common prefix would be "tdl.c")'
);

select * from finish();
rollback;
