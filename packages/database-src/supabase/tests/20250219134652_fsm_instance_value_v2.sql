begin;
select plan(4);

select has_function('fsm_core', 'get_fsm_data_resolve_state_value_v2', ARRAY['text'],
  'get_fsm_data_resolve_state_value_v2(text) exists');

select throws_ok(
  $$ select fsm_core.get_fsm_data_resolve_state_value_v2('00000000-0000-0000-0000-000000000099') $$,
  'P0001',
  '[get_fsm_data_resolve_state_value_v2] No fsm_instance found for id=00000000-0000-0000-0000-000000000099',
  'an unknown fsm_instance id raises'
);

-- Reuse the parallel-state fixture (compound root -> parallel p1 -> atomic c1/c2).
delete from fsm_core.fsm_instance where fsm_name = 'sv' and fsm_version = 'tv1';
delete from fsm_core.fsm_states where fsm_name = 'sv' and fsm_version = 'tv1';

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

insert into fsm_core.fsm_instance (id, fsm_name, fsm_version, fsm_instance_state)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 'sv', 'tv1', '{"p1": "c1"}'::jsonb);

select results_eq(
  $$ select (r->'fsm_instance_row'->>'id')::uuid, (r->'fsm_instance_row'->>'fsm_name'), (r->'fsm_instance_row'->>'fsm_version')
     from fsm_core.get_fsm_data_resolve_state_value_v2('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') r $$,
  $$ values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 'sv'::text, 'tv1'::text) $$,
  'the result embeds the looked-up fsm_instance row'
);
select results_eq(
  $$ select r->'resolved_state_value' from fsm_core.get_fsm_data_resolve_state_value_v2('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') r $$,
  $$ values ('{"json": {"root": {"p1": "c1"}}, "all_nodes": ["root.p1.c1", "root.p1.c2", "root.p1.c1"]}'::jsonb) $$,
  'the result embeds resolve_state_value_v2''s output for the instance''s current state'
);

select * from finish();
rollback;
