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
-- XState's microstep (packages/core/src/stateUtils.ts) for one transition,
-- one step per XState call:
--
--   const filteredTransitions = removeConflictingTransitions(transitions, ...);
--   if (!isInitial) [nextState, historyValue] = exitStates(...);              // 1
--   nextState = resolveActionsAndContext(..., filteredTransitions.flatMap((t) => t.actions));  // 2
--   nextState = enterStates(..., isInitial);                                   // 3
--   if (nextState.status === 'done') ... the remaining states' exit actions
--
-- exit_states_v2 and enter_states_v2 are exitStates and enterStates; the
-- active states (mutStateNodeSet) go from one to the other. Only one
-- transition is passed (no conflicts to remove), and the actions are returned
-- for the sync worker to run in that order instead of being run here.
-- `done` covers a top-level final state (4); done.state events and the exit
-- actions on completion are not done yet (#504).
DECLARE
	transition_actions JSONB;
	exit_result JSONB;
	entry_result JSONB;
	updated_state_nodes TEXT[];
	is_done BOOLEAN;
	is_initial BOOLEAN;
BEGIN
	RAISE NOTICE 'fsm_core.microstep_v2 called with event_name=%, fsm_name=%, fsm_version=%, state_value_node_set=%',
		event_name, fsm_name_param, fsm_version_param, state_value_node_set;

	-- The initial step enters the machine's initial states and exits nothing,
	-- whatever transition record it is given (#506).
	is_initial := event_name = 'initialTransition_event';

	-- 1. if (!isInitial) exitStates(...)
	IF is_initial THEN
		exit_result := jsonb_build_object(
			'exit_nodes', '[]'::jsonb,
			'exit_actions', '[]'::jsonb,
			'state_node_set', to_jsonb(COALESCE(state_value_node_set, ARRAY[]::TEXT[]))
		);
	ELSE
		exit_result := fsm_core.exit_states_v2(
			transition_record := transition_record,
			state_node_set := state_value_node_set,
			fsm_name_param := fsm_name_param,
			fsm_version_param := fsm_version_param
		);
	END IF;

	-- 2. resolveActionsAndContext(..., filteredTransitions.flatMap((t) => t.actions))
	transition_actions := transition_record.actions;

	-- 3. enterStates(..., isInitial), on the active states left after the exits
	entry_result := fsm_core.enter_states_v2(
		transition_record := transition_record,
		state_node_set := ARRAY(SELECT jsonb_array_elements_text(exit_result->'state_node_set')),
		is_initial := is_initial,
		fsm_name_param := fsm_name_param,
		fsm_version_param := fsm_version_param
	);
	updated_state_nodes := ARRAY(SELECT jsonb_array_elements_text(entry_result->'state_node_set'));

	-- 4. done: the machine is now in a top-level final state (a final child
	--    of the root), so the instance has finished and the sync worker
	--    marks it done (#500). The root is matched by parent_node rather
	--    than by ltree depth: a root id with dots spans several labels.
	is_done := EXISTS (
		SELECT 1
		FROM fsm_core.fsm_states fs
		JOIN fsm_core.fsm_states root
		  ON root.fsm_name = fs.fsm_name
		 AND root.fsm_version = fs.fsm_version
		 AND root.parent_node IS NULL
		 AND fs.parent_node = root.computed_state_key_ltree::text
		WHERE fs.fsm_name = fsm_name_param
		  AND fs.fsm_version = fsm_version_param
		  AND fs.type = 'final'
		  AND fs.computed_state_key_ltree::text = ANY(updated_state_nodes)
	);

	RETURN jsonb_build_object(
		'updated_state_value_node_set', updated_state_nodes,
		'updated_state_value', fsm_core.build_nested_json_recursive(paths := updated_state_nodes),
		'exit_actions', exit_result->'exit_actions',
		'entry_actions', entry_result->'entry_actions',
		'initial_actions', entry_result->'initial_actions',
		'transition_actions', transition_actions,
		'done', is_done
	);
END;
$$ LANGUAGE plpgsql;
