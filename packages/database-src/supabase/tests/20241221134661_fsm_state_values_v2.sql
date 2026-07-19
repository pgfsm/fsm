begin;
select plan(11);

select has_function('fsm_core', 'fsm_get_initial_state_nodes_v2', ARRAY['text', 'text', 'ltree'],
  'fsm_get_initial_state_nodes_v2(text, text, ltree) exists');
select has_function('fsm_core', 'fsm_get_initial_state_nodes_with_ancestors_v2', ARRAY['text', 'text', 'ltree'],
  'fsm_get_initial_state_nodes_with_ancestors_v2(text, text, ltree) exists');
select has_function('fsm_core', 'fsm_get_all_state_nodes_v2', ARRAY['text[]', 'text', 'text'],
  'fsm_get_all_state_nodes_v2(text[], text, text) exists');
select has_function('fsm_core', 'resolve_state_value_v2', ARRAY['jsonb', 'text', 'text'],
  'resolve_state_value_v2(jsonb, text, text) exists');

-- Isolate from any pre-existing rows for this fsm_name/version.
delete from fsm_core.fsm_states where fsm_name = 'sv' and fsm_version = 'tv1';

-- Fixture: compound root -> parallel p1 -> two atomic children c1/c2.
insert into fsm_core.fsm_states
  (state_id_with_fsm_name_and_fsm_version, computed_state_id_ltree, computed_state_key_ltree,
   id, key, parent_node, type, fsm_order, initial, states, fsm_name, fsm_version)
values
  ('sv.tv1.root', 'root', 'root', 'root', 'root', NULL, 'compound', 1,
   '{"target": ["#root.p1"], "source": "#root"}'::jsonb, NULL, 'sv', 'tv1'),
  ('sv.tv1.root.p1', 'root.p1', 'root.p1', 'root.p1', 'p1', 'root', 'parallel', 2,
   NULL, '{"c1": {"id": "root.p1.c1", "key": "c1"}, "c2": {"id": "root.p1.c2", "key": "c2"}}'::jsonb, 'sv', 'tv1'),
  ('sv.tv1.root.p1.c1', 'root.p1.c1', 'root.p1.c1', 'root.p1.c1', 'c1', 'root.p1', 'atomic', 3, NULL, NULL, 'sv', 'tv1'),
  ('sv.tv1.root.p1.c2', 'root.p1.c2', 'root.p1.c2', 'root.p1.c2', 'c2', 'root.p1', 'atomic', 4, NULL, NULL, 'sv', 'tv1');

select results_eq(
  $$ select fsm_core.fsm_get_initial_state_nodes_v2('sv', 'tv1', 'root'::ltree) $$,
  $$ values (ARRAY['root', 'root.p1', 'root.p1.c1', 'root.p1.c2']::text[]) $$,
  'drills through a compound''s initial target into a parallel''s children, including the start node itself'
);
select results_eq(
  $$ select fsm_core.fsm_get_initial_state_nodes_v2('sv', 'tv1', 'root.p1'::ltree) $$,
  $$ values (ARRAY['root.p1', 'root.p1.c1', 'root.p1.c2']::text[]) $$,
  'starting directly at the parallel node yields itself plus both children'
);
select results_eq(
  $$ select fsm_core.fsm_get_initial_state_nodes_with_ancestors_v2('sv', 'tv1', 'root'::ltree) $$,
  $$ values (ARRAY['root', 'root.p1', 'root.p1.c1', 'root.p1.c2']::text[]) $$,
  'no extra ancestors are added when the initial nodes already sit directly under the start node'
);
select results_eq(
  $$ select fsm_core.fsm_get_all_state_nodes_v2(ARRAY['root'], 'sv', 'tv1') $$,
  $$ values (ARRAY['root', 'root.p1', 'root.p1.c1', 'root.p1.c2']::text[]) $$,
  'a lone compound root path expands to its full initial-state subtree'
);
select results_eq(
  $$ select fsm_core.fsm_get_all_state_nodes_v2(ARRAY['root', 'root.p1.c1'], 'sv', 'tv1') $$,
  $$ values (ARRAY['root', 'root.p1', 'root.p1.c1', 'root.p1.c2', 'root.p1.c1']::text[]) $$,
  'an atomic path already covered by the compound expansion is still appended again (current behavior: not deduplicated across branches)'
);
select results_eq(
  $$ select fsm_core.resolve_state_value_v2('{}'::jsonb, 'sv', 'tv1') $$,
  $$ values ('{"json": {"root": {"p1": "c2"}}, "all_nodes": ["root", "root.p1", "root.p1.c1", "root.p1.c2"]}'::jsonb) $$,
  'resolving an empty state value against the root falls back to the full initial-state subtree'
);
select results_eq(
  $$ select fsm_core.resolve_state_value_v2('{"p1": "c1"}'::jsonb, 'sv', 'tv1') $$,
  $$ values ('{"json": {"root": {"p1": "c1"}}, "all_nodes": ["root.p1.c1", "root.p1.c2", "root.p1.c1"]}'::jsonb) $$,
  'resolving an explicit parallel-branch selection preserves that selection in the rebuilt JSON'
);

select * from finish();
rollback;
