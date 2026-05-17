-- fsm_core.microstep_v2 function: performs a single FSM fsm_core.microstep_v2
-- Arguments:
-- 	 transition_record fsm_core.fsm_transitions
--   event_name TEXT
--   state_value_node_set TEXT[]
--   fsm_name_param TEXT
--   fsm_version_param TEXT
-- Returns: JSONB with updated state node set and actions
CREATE OR REPLACE FUNCTION fsm_core.microstep_v2(
	transition_record fsm_core.fsm_transitions,
	event_name TEXT,
	state_value_node_set TEXT[],
	fsm_name_param TEXT,
	fsm_version_param TEXT
)
RETURNS JSONB AS $$
DECLARE
	
	transition_actions JSONB;
	exit_result JSONB;
	entry_result JSONB;
	exit_nodes TEXT[];
	entry_nodes TEXT[];
	updated_state_nodes TEXT[];
	updated_state_nodes_jsonb JSONB;
	exit_actions JSONB;
	entry_actions JSONB;
	initial_actions JSONB;
	result_json JSONB;
BEGIN
	RAISE NOTICE 'fsm_core.microstep_v2 called with event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;
	
	RAISE NOTICE 'state_value_node_set: %', state_value_node_set;


	-- 1. Call processEventTransitionForExit
	exit_result := fsm_core.compute_exit_actions_v2(transition_record := transition_record, p_state_node_set := state_value_node_set, p_fsm_name := transition_record.fsm_name, p_fsm_version := transition_record.fsm_version);
	RAISE NOTICE 'exit_result: %', exit_result;
	SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[]) INTO exit_nodes
	FROM jsonb_array_elements_text(COALESCE(exit_result->'exit_nodes', '[]'::jsonb));
	RAISE NOTICE 'exit_nodes: %', exit_nodes;


	-- 2. transition_actions
	transition_actions := transition_record.actions;
	RAISE NOTICE 'transition_actions: %', transition_actions; 

	-- 3. Call fsm_core.compute_entry_actions_v2
	-- if event is initialTransition_event, set is_initial_transition to TRUE
	IF event_name = 'initialTransition_event' THEN
		entry_result := fsm_core.compute_entry_actions_v2(transition_record := transition_record, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param, is_initial_transition := TRUE);
	ELSE
		entry_result := fsm_core.compute_entry_actions_v2(transition_record := transition_record, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param, is_initial_transition := FALSE);
	END IF;
	RAISE NOTICE 'entry_result: %', entry_result;
	SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[]) INTO entry_nodes
	FROM jsonb_array_elements_text(COALESCE(entry_result->'states_to_enter', '[]'::jsonb));
	RAISE NOTICE 'entry_nodes: %', entry_nodes;
	

	-- 4. Compute updated state node set:
	--    (state_value_node_set - exit_nodes) + entry_nodes
	updated_state_nodes := ARRAY(
		SELECT DISTINCT x FROM (
			SELECT unnest(state_value_node_set) AS x
			EXCEPT
			SELECT unnest(exit_nodes) AS x
			UNION
			SELECT unnest(entry_nodes) AS x
		) t
	);
	RAISE NOTICE 'updated_state_nodes: %', updated_state_nodes;

	
	updated_state_nodes_jsonb := fsm_core.build_nested_json_recursive(paths := updated_state_nodes);
	RAISE NOTICE 'updated_state_nodes_jsonb: %', updated_state_nodes_jsonb;

	-- 5. Return result as JSONB
	result_json := jsonb_build_object(
		'updated_state_value_node_set', updated_state_nodes,
		'updated_state_value', updated_state_nodes_jsonb,
		'exit_actions', exit_result->'exit_actions',
		'entry_actions', entry_result->'entry_actions_for_states_to_enter',
		'initial_actions', entry_result->'initial_actions_for_common_states',
		'transition_actions', transition_actions
	);
	RAISE NOTICE 'fsm_core.microstep_v2 result: %', result_json;
	RETURN result_json;
END;
$$ LANGUAGE plpgsql;
