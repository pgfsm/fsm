-- #503: resolving a saved state value keeps a parallel state's regions where
-- they are, including regions that reached their final state, and returns
-- the full configuration (active leaves plus their ancestors).
begin;
select plan(7);

delete from fsm_core.fsm_states where fsm_name = 'svp' and fsm_version in ('tv1', 'tv2');

-- Fixture: compound root -> parallel w -> compound regions a/b, each starting
-- at atomic "run" with a final "done".
insert into fsm_core.fsm_states
  (state_id_with_fsm_name_and_fsm_version, computed_state_id_ltree, computed_state_key_ltree,
   id, key, parent_node, type, fsm_order, initial, states, fsm_name, fsm_version)
values
  ('svp.tv1.root', 'root', 'root', 'root', 'root', NULL, 'compound', 1,
   '{"target": ["#root.w"], "source": "#root"}'::jsonb, NULL, 'svp', 'tv1'),
  ('svp.tv1.root.w', 'root.w', 'root.w', 'root.w', 'w', 'root', 'parallel', 2,
   NULL, '{"a": {"id": "root.w.a", "key": "a"}, "b": {"id": "root.w.b", "key": "b"}}'::jsonb, 'svp', 'tv1'),
  ('svp.tv1.root.w.a', 'root.w.a', 'root.w.a', 'root.w.a', 'a', 'root.w', 'compound', 3,
   '{"target": ["#root.w.a.run"], "source": "#root.w.a"}'::jsonb, NULL, 'svp', 'tv1'),
  ('svp.tv1.root.w.a.run', 'root.w.a.run', 'root.w.a.run', 'root.w.a.run', 'run', 'root.w.a', 'atomic', 4, NULL, NULL, 'svp', 'tv1'),
  ('svp.tv1.root.w.a.done', 'root.w.a.done', 'root.w.a.done', 'root.w.a.done', 'done', 'root.w.a', 'final', 5, NULL, NULL, 'svp', 'tv1'),
  ('svp.tv1.root.w.b', 'root.w.b', 'root.w.b', 'root.w.b', 'b', 'root.w', 'compound', 6,
   '{"target": ["#root.w.b.run"], "source": "#root.w.b"}'::jsonb, NULL, 'svp', 'tv1'),
  ('svp.tv1.root.w.b.run', 'root.w.b.run', 'root.w.b.run', 'root.w.b.run', 'run', 'root.w.b', 'atomic', 7, NULL, NULL, 'svp', 'tv1'),
  ('svp.tv1.root.w.b.done', 'root.w.b.done', 'root.w.b.done', 'root.w.b.done', 'done', 'root.w.b', 'final', 8, NULL, NULL, 'svp', 'tv1');

select results_eq(
  $$ select fsm_core.resolve_state_value_v2('{"w": {"a": "done", "b": "run"}}'::jsonb, 'svp', 'tv1')->'json' $$,
  $$ values ('{"root": {"w": {"a": "done", "b": "run"}}}'::jsonb) $$,
  'a region that reached its final state stays there; the other keeps its state'
);
select ok(
  (fsm_core.resolve_state_value_v2('{"w": {"a": "done", "b": "run"}}'::jsonb, 'svp', 'tv1')->'all_nodes')
    ?& ARRAY['root', 'root.w', 'root.w.a', 'root.w.a.done', 'root.w.b', 'root.w.b.run'],
  'all_nodes is the full configuration: active leaves (final included) and their ancestors'
);
select ok(
  not ((fsm_core.resolve_state_value_v2('{"w": {"a": "done", "b": "run"}}'::jsonb, 'svp', 'tv1')->'all_nodes')
    ?| ARRAY['root.w.a.run', 'root.w.b.done']),
  'regions in the saved state are not reset to their initial state'
);
select results_eq(
  $$ select fsm_core.resolve_state_value_v2('{"w": {"a": "done", "b": "done"}}'::jsonb, 'svp', 'tv1')->'json' $$,
  $$ values ('{"root": {"w": {"a": "done", "b": "done"}}}'::jsonb) $$,
  'with every region final, the saved state is kept as is'
);

-- Fixture tv2: as tv1, but region a has a custom id ("cust", so its id path
-- is not its key path) and w has a history child h, which is not a region.
insert into fsm_core.fsm_states
  (state_id_with_fsm_name_and_fsm_version, computed_state_id_ltree, computed_state_key_ltree,
   id, key, parent_node, type, fsm_order, initial, states, fsm_name, fsm_version)
values
  ('svp.tv2.root', 'root', 'root', 'root', 'root', NULL, 'compound', 1,
   '{"target": ["#root.w"], "source": "#root"}'::jsonb, NULL, 'svp', 'tv2'),
  ('svp.tv2.root.w', 'root.w', 'root.w', 'root.w', 'w', 'root', 'parallel', 2,
   NULL, '{"a": {"id": "cust", "key": "a"}, "b": {"id": "root.w.b", "key": "b"}, "h": {"id": "root.w.h", "key": "h"}}'::jsonb, 'svp', 'tv2'),
  ('svp.tv2.cust', 'cust', 'root.w.a', 'cust', 'a', 'root.w', 'compound', 3,
   '{"target": ["#cust.run"], "source": "#cust"}'::jsonb, NULL, 'svp', 'tv2'),
  ('svp.tv2.cust.run', 'cust.run', 'root.w.a.run', 'cust.run', 'run', 'root.w.a', 'atomic', 4, NULL, NULL, 'svp', 'tv2'),
  ('svp.tv2.cust.done', 'cust.done', 'root.w.a.done', 'cust.done', 'done', 'root.w.a', 'final', 5, NULL, NULL, 'svp', 'tv2'),
  ('svp.tv2.root.w.b', 'root.w.b', 'root.w.b', 'root.w.b', 'b', 'root.w', 'compound', 6,
   '{"target": ["#root.w.b.run"], "source": "#root.w.b"}'::jsonb, NULL, 'svp', 'tv2'),
  ('svp.tv2.root.w.b.run', 'root.w.b.run', 'root.w.b.run', 'root.w.b.run', 'run', 'root.w.b', 'atomic', 7, NULL, NULL, 'svp', 'tv2'),
  ('svp.tv2.root.w.b.done', 'root.w.b.done', 'root.w.b.done', 'root.w.b.done', 'done', 'root.w.b', 'final', 8, NULL, NULL, 'svp', 'tv2'),
  ('svp.tv2.root.w.h', 'root.w.h', 'root.w.h', 'root.w.h', 'h', 'root.w', 'history', 9, NULL, NULL, 'svp', 'tv2');

select ok(
  (fsm_core.resolve_state_value_v2('{"w": {"a": "done", "b": "run"}}'::jsonb, 'svp', 'tv2')->'all_nodes')
    ?& ARRAY['root', 'root.w', 'root.w.a', 'root.w.a.done', 'root.w.b', 'root.w.b.run'],
  'a region with a custom id is matched by its key path and keeps its state'
);
select ok(
  not ((fsm_core.resolve_state_value_v2('{"w": {"a": "done", "b": "run"}}'::jsonb, 'svp', 'tv2')->'all_nodes')
    ?| ARRAY['cust', 'root.w.a.run']),
  'a custom id never appears as a path, and its region is not restarted'
);
select ok(
  not ((fsm_core.resolve_state_value_v2('{"w": {"a": "done", "b": "run"}}'::jsonb, 'svp', 'tv2')->'all_nodes')
    ? 'root.w.h'),
  'a history child of a parallel state is not started as a region'
);

select * from finish();
rollback;
