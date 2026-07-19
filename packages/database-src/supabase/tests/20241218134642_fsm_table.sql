begin;
select plan(45);

-- fsm_core.fsm_json
select has_table('fsm_core', 'fsm_json', 'fsm_core.fsm_json exists');
select col_is_pk('fsm_core', 'fsm_json', 'id', 'fsm_json.id is the primary key');
select col_type_is('fsm_core', 'fsm_json', 'fsm_name', 'text', 'fsm_json.fsm_name is text');
select col_type_is('fsm_core', 'fsm_json', 'fsm_type', 'text', 'fsm_json.fsm_type is text');
select col_type_is('fsm_core', 'fsm_json', 'fsm_version', 'text', 'fsm_json.fsm_version is text');
select col_type_is('fsm_core', 'fsm_json', 'fsm_json', 'jsonb', 'fsm_json.fsm_json is jsonb');

-- fsm_core.fsm_state_type (enum)
select has_type('fsm_core', 'fsm_state_type', 'fsm_core.fsm_state_type exists');
select enum_has_labels('fsm_core', 'fsm_state_type',
  ARRAY['atomic', 'compound', 'parallel', 'final', 'history'],
  'fsm_state_type has the expected five labels');

-- fsm_core.fsm_states
select has_table('fsm_core', 'fsm_states', 'fsm_core.fsm_states exists');
select col_is_pk('fsm_core', 'fsm_states', 'state_id_with_fsm_name_and_fsm_version',
  'fsm_states.state_id_with_fsm_name_and_fsm_version is the primary key');
select col_type_is('fsm_core', 'fsm_states', 'state_id_with_fsm_name_and_fsm_version', 'text',
  'fsm_states.state_id_with_fsm_name_and_fsm_version is text');
select col_type_is('fsm_core', 'fsm_states', 'id', 'text', 'fsm_states.id is text');
select col_type_is('fsm_core', 'fsm_states', 'computed_state_id_ltree', 'ltree',
  'fsm_states.computed_state_id_ltree is ltree');
select col_type_is('fsm_core', 'fsm_states', 'key', 'text', 'fsm_states.key is text');
select col_type_is('fsm_core', 'fsm_states', 'computed_state_key_ltree', 'ltree',
  'fsm_states.computed_state_key_ltree is ltree');
select col_type_is('fsm_core', 'fsm_states', 'parent_node', 'text', 'fsm_states.parent_node is text');
select col_type_is('fsm_core', 'fsm_states', 'type', 'fsm_core.fsm_state_type',
  'fsm_states.type is fsm_core.fsm_state_type');
select col_type_is('fsm_core', 'fsm_states', 'description', 'text', 'fsm_states.description is text');
select col_type_is('fsm_core', 'fsm_states', 'fsm_order', 'integer', 'fsm_states.fsm_order is integer');
select col_type_is('fsm_core', 'fsm_states', 'context', 'jsonb', 'fsm_states.context is jsonb');
select col_type_is('fsm_core', 'fsm_states', 'states', 'jsonb', 'fsm_states.states is jsonb');
select col_type_is('fsm_core', 'fsm_states', 'initial', 'jsonb', 'fsm_states.initial is jsonb');
select col_type_is('fsm_core', 'fsm_states', 'fsm_on', 'jsonb', 'fsm_states.fsm_on is jsonb');
select col_type_is('fsm_core', 'fsm_states', 'transitions', 'jsonb', 'fsm_states.transitions is jsonb');
select col_type_is('fsm_core', 'fsm_states', 'entry', 'jsonb', 'fsm_states.entry is jsonb');
select col_type_is('fsm_core', 'fsm_states', 'exit', 'jsonb', 'fsm_states.exit is jsonb');
select col_type_is('fsm_core', 'fsm_states', 'invoke', 'jsonb', 'fsm_states.invoke is jsonb');
select col_type_is('fsm_core', 'fsm_states', 'data', 'jsonb', 'fsm_states.data is jsonb');
select col_type_is('fsm_core', 'fsm_states', 'history', 'text', 'fsm_states.history is text');
select col_type_is('fsm_core', 'fsm_states', 'fsm_version', 'text', 'fsm_states.fsm_version is text');
select col_type_is('fsm_core', 'fsm_states', 'fsm_name', 'text', 'fsm_states.fsm_name is text');

-- fsm_core.fsm_transitions
select has_table('fsm_core', 'fsm_transitions', 'fsm_core.fsm_transitions exists');
select col_is_pk('fsm_core', 'fsm_transitions', 'id', 'fsm_transitions.id is the primary key');
select col_type_is('fsm_core', 'fsm_transitions', 'id', 'integer', 'fsm_transitions.id is integer');
select col_type_is('fsm_core', 'fsm_transitions', 'actions', 'jsonb', 'fsm_transitions.actions is jsonb');
select col_type_is('fsm_core', 'fsm_transitions', 'cond', 'jsonb', 'fsm_transitions.cond is jsonb');
select col_type_is('fsm_core', 'fsm_transitions', 'event_type', 'text', 'fsm_transitions.event_type is text');
select col_type_is('fsm_core', 'fsm_transitions', 'source', 'text', 'fsm_transitions.source is text');
select col_type_is('fsm_core', 'fsm_transitions', 'computed_sanitized_source_ltree', 'ltree',
  'fsm_transitions.computed_sanitized_source_ltree is ltree');
select col_type_is('fsm_core', 'fsm_transitions', 'target', 'text[]', 'fsm_transitions.target is text[]');
select col_type_is('fsm_core', 'fsm_transitions', 'computed_sanitized_target_ltree_array', 'ltree[]',
  'fsm_transitions.computed_sanitized_target_ltree_array is ltree[]');
select col_type_is('fsm_core', 'fsm_transitions', 'reenter', 'boolean', 'fsm_transitions.reenter is boolean');
select col_type_is('fsm_core', 'fsm_transitions', 'computed_transition_domain_lca', 'text',
  'fsm_transitions.computed_transition_domain_lca is text');
select col_type_is('fsm_core', 'fsm_transitions', 'fsm_name', 'text', 'fsm_transitions.fsm_name is text');
select col_type_is('fsm_core', 'fsm_transitions', 'fsm_version', 'text', 'fsm_transitions.fsm_version is text');

select * from finish();
rollback;
