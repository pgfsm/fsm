-- Deprecated: this should be done in application layer
-- ignore below select_transitions function
CREATE OR REPLACE FUNCTION fsm_core.select_transitions_with_guard_eval_v1(
	input_all_transitions fsm_core.fsm_transitions[]
)
RETURNS SETOF fsm_core.fsm_transitions AS $$
DECLARE
	transition_record fsm_core.fsm_transitions;
	guard_value BOOLEAN;
BEGIN

	RAISE NOTICE 'fsm_core.select_transitions_with_guard_eval_v1 called with input_all_transitions: %', input_all_transitions;
	FOR transition_record IN SELECT * FROM unnest(input_all_transitions) LOOP
		-- Default guard to TRUE when no cond provided
		guard_value := TRUE;

		IF transition_record.cond IS NOT NULL THEN
			RAISE NOTICE 'Evaluating guard condition and guard condition value: %', transition_record.cond;
			-- If cond has a 'type' field, call the named SQL function and pass cond->>'param' as JSONB
			IF transition_record.cond ? 'type' THEN
				RAISE NOTICE 'Calling guard function: % with param: %', transition_record.cond->>'type', transition_record.cond->>'param';

				EXECUTE 'SELECT ' || quote_ident(transition_record.cond->>'type') || '($1)'
				INTO guard_value
				USING (transition_record.cond->>'param')::JSONB;
				RAISE NOTICE 'Guard function result: %', guard_value;
			ELSE
				RAISE NOTICE 'Evaluating guard condition without function and guard condition value: %', transition_record.cond;
				-- Try common shapes: check for 'value' or 'predicate' keys, else if cond is boolean JSONB
				IF transition_record.cond ? 'value' THEN
					guard_value := COALESCE((transition_record.cond->>'value')::BOOLEAN, TRUE);
				-- ELSIF transition_record.cond ? 'predicate' THEN
				-- 	guard_value := COALESCE((transition_record.cond->>'predicate')::BOOLEAN, TRUE);
				ELSIF jsonb_typeof(transition_record.cond) = 'boolean' THEN
					-- cond is a bare boolean JSON value (true/false)
					guard_value := (transition_record.cond::TEXT)::BOOLEAN;
					RAISE NOTICE 'Guard boolean value: %', guard_value;
				ELSE
					-- Unknown cond structure: default to TRUE to avoid dropping transitions unexpectedly
					guard_value := TRUE;
					RAISE NOTICE 'Unknown guard condition structure, defaulting to TRUE';
				END IF;
			END IF;
		END IF;

		-- If guard evaluates to true, yield the transition record
		IF guard_value THEN
			RAISE NOTICE 'Guard condition passed, returning transition: %', transition_record;
			RETURN NEXT transition_record;
		END IF;
	END LOOP;

	RETURN;
END;
$$ LANGUAGE plpgsql;

 
-- select fsm_core.select_transitions_with_guard_eval_v1('xstate.done.state.(machine).creditCheck.CheckingCreditScores', 'creditCheck', 'v3');

DROP FUNCTION IF EXISTS fsm_core.select_all_transitions_v1(TEXT, TEXT[], TEXT, TEXT);
CREATE OR REPLACE FUNCTION fsm_core.select_all_transitions_v1(
	event_name TEXT,
	p_state_value TEXT[],
	fsm_name_param TEXT,
	fsm_version_param TEXT
)
RETURNS JSONB AS $$
DECLARE
	transitions JSONB;
BEGIN
	transitions := (
		SELECT jsonb_agg(t)
		FROM (
			SELECT * FROM fsm_core.fsm_transitions
			WHERE event_type = event_name
			  AND computed_sanitized_source_ltree::text = ANY(p_state_value)
			  AND fsm_name = fsm_name_param
			  AND fsm_version = fsm_version_param
		) t
	);
	IF transitions IS NULL THEN
		transitions := '[]'::jsonb;
	END IF;
	RETURN transitions;
END;
$$ LANGUAGE plpgsql;


-- select fsm_core.select_all_transitions_v1(
-- 'xstate.done.actor.0.(machine).creditCheck.Verifying Credentials', 
-- -- ARRAY['machine.creditCheck']::TEXT[],
-- -- ARRAY['machine', 'machine.creditCheck', 'machine.creditCheck.Entering_Information']::TEXT[],
-- ARRAY['machine.creditCheck.Verifying_Credentials']::TEXT[],
-- -- ARRAY['machine', 'machine.creditCheck', 'machine.creditCheck.Verifying_Credentials']::TEXT[],
-- 'creditCheck', 
-- '20250102030405'
-- );


select fsm_core.select_all_transitions_v1(
'Submit', 
ARRAY['machine', 'machine.creditCheck', 'machine.creditCheck.Entering_Information']::TEXT[],
'creditCheck', 
'v1'
);

SELECT array_agg(t) INTO all_transition_records FROM fsm_core.select_all_transitions_v1(
'Submit', 
ARRAY['machine', 'machine.creditCheck', 'machine.creditCheck.Entering_Information']::TEXT[],
'creditCheck', 
'v1'
) t;


-- this should be simulated in application layer, we can call fsm_core.select_transitions_with_guard_eval_v1 function to get the valid transitions based on guard evaluation, 
-- and then call fsm_core.microstep_v1 with the valid transition record, here we are simulating the whole flow in SQL for testing and demonstration purpose
CREATE OR REPLACE FUNCTION fsm_core.macrostep_v1(
	event_name TEXT,
	p_state_value TEXT[],
	fsm_name_param TEXT,
	fsm_version_param TEXT
)
RETURNS JSONB AS $$
DECLARE
	
	transition_record fsm_core.fsm_transitions;
    all_transition_records fsm_core.fsm_transitions[];
	guard_eval_transition_records fsm_core.fsm_transitions[];
	
	microstep_result JSONB;
BEGIN
	RAISE NOTICE 'fsm_core.macrostep_v1 called with event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;

	IF event_name = 'initialTransition_event' THEN
		RAISE NOTICE 'Initial transition event, skipping fsm_core.select_all_transitions_v1 and guard evaluation, directly calling fsm_core.microstep_v1 with empty transition_record';
		transition_record := NULL; -- or you can create a dummy transition_record with necessary fields for initial transition
	ELSE
		RAISE NOTICE 'Non-initial transition event, selecting all transitions and performing guard evaluation';
		SELECT array_agg(t) INTO all_transition_records
		FROM (
			SELECT (jsonb_populate_record(NULL::fsm_core.fsm_transitions, elem))::fsm_core.fsm_transitions AS t
			FROM jsonb_array_elements(fsm_core.select_all_transitions_v1(event_name, p_state_value, fsm_name_param, fsm_version_param)) elem
		) sub;

		RAISE NOTICE 'Number of transition_records found: %', array_length(all_transition_records, 1);

		IF all_transition_records IS NULL OR array_length(all_transition_records, 1) IS NULL THEN
			
			RAISE EXCEPTION 'No valid transitions found for event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;
		
		ELSIF array_length(all_transition_records, 1) > 1 THEN
			
			RAISE NOTICE 'Number of transition_records found: %', array_length(all_transition_records, 1);
			
			-- method 1: temp solution
			-- RAISE NOTICE 'SKIP : Evaluating guard : Selecting the first transition_record without guard evaluation for fsm_core.microstep_v1, this is a temporary solution and should be replaced with proper guard evaluation and conflict resolution strategy';  
			-- transition_record := all_transition_records[1];

			-- method 2: call Evaluate guard conditions again in SQL to find the valid transition record, if multiple records are still valid after evaluation, raise exception
			RAISE NOTICE 'RUN : Evaluating guard : conditions for all transition_records in SQL to find the valid transition record';
			SELECT array_agg(t) INTO guard_eval_transition_records
				FROM fsm_core.select_transitions_with_guard_eval_v1(all_transition_records) t;

			RAISE NOTICE 'Number of transition_records after guard evaluation: %', array_length(guard_eval_transition_records, 1);
			IF guard_eval_transition_records IS NULL OR array_length(guard_eval_transition_records, 1) IS NULL THEN
				RAISE EXCEPTION 'No valid transitions found after guard evaluation for event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;
			ELSIF array_length(guard_eval_transition_records, 1) > 1 THEN
				RAISE NOTICE 'removeConflictingTransitions needed to resolve multiple transitions after guard evaluation for event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;
				-- In real implementation, we should have a conflict resolution strategy to select one transition record among multiple valid records, here we are just raising exception for demonstration purpose

				
				RAISE EXCEPTION 'Multiple valid transitions found after guard evaluation for event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;
			ELSIF array_length(guard_eval_transition_records, 1) = 1 THEN
				RAISE NOTICE 'One transition_record found after guard evaluation, selecting it for fsm_core.microstep_v1';
				transition_record := guard_eval_transition_records[1];
				RAISE NOTICE 'Selected transition_record: %', transition_record;

			END IF;

		ELSIF array_length(all_transition_records, 1) = 1 THEN

			RAISE NOTICE 'One transition_record found, selecting it for fsm_core.microstep_v1';
			transition_record := all_transition_records[1];
			RAISE NOTICE 'Selected transition_record: %', transition_record;	

		END IF;

		

	END IF;
	

	-- Call fsm_core.microstep_v1 and return its JSONB result
	microstep_result := fsm_core.microstep_v1(
		transition_record,
		event_name,
		p_state_value,
		fsm_name_param,
		fsm_version_param
	);

	RAISE NOTICE 'microstep_result: %', microstep_result;

	RETURN microstep_result;
END;
$$ LANGUAGE plpgsql;


-- -- initialTransition transition test 
-- '{}'::jsonb would be resolved in ARRAY['machine', 'machine.creditCheck', 'machine.creditCheck.Entering_Information'] in fsm_core.fsm_worker_v1, so we can directly pass the resolved value here for testing fsm_core.macrostep_v1
-- SELECT fsm_core.macrostep_v1(
-- 'initialTransition_event', 
-- ARRAY['machine', 'machine.creditCheck', 'machine.creditCheck.Entering_Information']::TEXT[],
-- 'creditCheck', 
-- '20250102030405'
-- );

-- -- -- Submit
-- SELECT fsm_core.macrostep_v1(
-- 'Submit',
-- ARRAY['machine.creditCheck','machine.creditCheck.Entering_Information']::TEXT[], 
-- 'creditCheck',
-- '20250102030405'
-- );





--  call resolve_state_value_result and call fsm_core.macrostep_v1 in fsm_core.fsm_worker_v1
CREATE OR REPLACE FUNCTION fsm_core.fsm_worker_v1(
	event_name TEXT,
	p_state_value JSONB,
	fsm_name_param TEXT,
	fsm_version_param TEXT
)
RETURNS JSONB AS $$
DECLARE
	resolve_state_value_result JSONB;
	state_node_set TEXT[];
	
	macrostep_result JSONB;
BEGIN
	RAISE NOTICE 'fsm_core.fsm_worker_v1 called with event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;

	
	-- in Actual Language, single SQL function like get_fsm_data_and_resolve_state_value can be called which internally calls get_fsm_data and resolve_state_value, here we are calling resolve_state_value directly for simplicity
	-- assume p_state_value value would be drived from get_fsm_data function which fetches the current state value from database based on fsm_name and fsm_version, and then resolve_state_value function resolves it to get the set of active state nodes
	select fsm_core.resolve_state_value_v1(p_state_value::jsonb, fsm_name_param, fsm_version_param) INTO resolve_state_value_result;

	RAISE NOTICE 'resolve_state_value_result: %', resolve_state_value_result;
	state_node_set := array(
		SELECT jsonb_array_elements_text(resolve_state_value_result->'all_nodes')
	);
	
	RAISE NOTICE 'state_node_set: %', state_node_set;

	
	-- Call fsm_core.macrostep_v1 and return its JSONB result
	macrostep_result := fsm_core.macrostep_v1(
		event_name,
		state_node_set,
		fsm_name_param,
		fsm_version_param
	);

	RAISE NOTICE 'fsm_core.macrostep_v1: %', macrostep_result;

	-- call archive_event_from_fsm_type_worker with right Data

	RETURN macrostep_result;
END;
$$ LANGUAGE plpgsql;



-- -- initialTransition transition test
-- SELECT fsm_core.fsm_worker_v1(
-- 'initialTransition_event', 
-- '{}'::jsonb, 
-- 'creditCheck', 
-- 'v1'
-- );

-- -- -- -- Submit
-- SELECT fsm_core.fsm_worker_v1(
-- 'Submit', 
-- '{"creditCheck": "Entering Information"}'::jsonb, 
-- 'creditCheck', 
-- 'v1'
-- );

-- -- -- xstate.done.actor.0.(machine).creditCheck.Verifying Credentials
-- SELECT fsm_core.fsm_worker_v1(
-- 'xstate.done.actor.0.(machine).creditCheck.Verifying Credentials', 
-- '{"creditCheck": "Verifying_Credentials"}'::jsonb, 
-- 'creditCheck', 
-- '20250102030405'
-- );


-- -- -- -- xstate.done.state.(machine).creditCheck.CheckingCreditScores
-- SELECT fsm_core.fsm_worker_v1(
-- 'xstate.done.state.(machine).creditCheck.CheckingCreditScores', 
-- '{"creditCheck": "CheckingCreditScores"}'::jsonb, 
-- 'creditCheck', 
-- '20250102030405'
-- );

-- -- -- allstepfinished
-- SELECT fsm_core.fsm_worker_v1(
-- 'allstepfinished', 
-- '{
    
--         "creditCheck" : {
--             "CheckingCreditScores": {
--                 "CheckingEquiGavin": "CheckingForExistingReport",
--                 "CheckingGavUnion": "CheckingForExistingReport",
--                 "CheckingGavperian": "CheckingForExistingReport"
--             }
--         }
    
-- }'::jsonb,
-- 'creditCheck', 
-- 'v3'
-- );


-- SELECT fsm_core.fsm_worker_v1(
-- 	'set.dark.custom',
-- 	'{"mode": "light", "theme": "default"}'::jsonb,
-- 	'parallelMachineTest',
-- 	'v1'
-- );