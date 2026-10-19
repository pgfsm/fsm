CREATE OR REPLACE FUNCTION fsm_core.get_exit_actions_v2(
    input_state_paths TEXT[],
    input_fsm_name TEXT,
    input_fsm_version TEXT
)
RETURNS JSONB AS $$
DECLARE
    all_actions JSONB := '[]'::jsonb;
    rec RECORD;
    action JSONB;
    i INTEGER;
BEGIN
    -- Collect all actions from matching records
    
    FOR rec IN
        SELECT 
            COALESCE(fs.exit, '[]'::jsonb) AS exit_actions,
            COALESCE(fs.invoke, '[]'::jsonb) AS invoke_actions,
            fs.fsm_order
        FROM fsm_core.fsm_states fs
        WHERE 
            -- input_state_paths should be always matched from computed_state_key_ltree column
            fs.computed_state_key_ltree = ANY(input_state_paths::ltree[])
            AND fs.fsm_name = input_fsm_name
            AND fs.fsm_version = input_fsm_version
        ORDER BY fs.fsm_order DESC
    LOOP
        -- Process exit actions and add to combined array
        IF jsonb_array_length(rec.exit_actions) > 0 THEN
            FOR i IN 0..jsonb_array_length(rec.exit_actions)-1 LOOP
                action := rec.exit_actions->i;
                action := action || jsonb_build_object(
                    'fsm_order', rec.fsm_order,
                    'action_type', 'exit'
                );
                all_actions := all_actions || jsonb_build_array(action);
            END LOOP;
        END IF;
        
        -- Process invoke actions and add to combined array
        IF jsonb_array_length(rec.invoke_actions) > 0 THEN
            FOR i IN 0..jsonb_array_length(rec.invoke_actions)-1 LOOP
                action := rec.invoke_actions->i;
                action := action || jsonb_build_object(
                    'fsm_order', rec.fsm_order,
                    'action_type', 'invoke'
                );
                all_actions := all_actions || jsonb_build_array(action);
            END LOOP;
        END IF;
    END LOOP;
    
    -- Return single JSON with combined actions array
    -- Actions are already sorted by fsm_order DESC due to the ORDER BY in the query
    RETURN jsonb_build_object('actions', all_actions);
END;
$$ LANGUAGE plpgsql IMMUTABLE;


CREATE OR REPLACE FUNCTION fsm_core.compute_full_exit_set_v2(
  transition_record fsm_core.fsm_transitions,
  state_node_set TEXT[]
) RETURNS TEXT[] AS $$
-- XState's computeExitSet (packages/core/src/stateUtils.ts) for one
-- transition, step by step:
--
--   if (t.target?.length) {
--     const domain = getTransitionDomain(t, historyValue);
--     if (t.reenter && t.source === domain) statesToExit.add(domain);
--     for (const stateNode of stateNodeSet) {
--       if (isDescendant(stateNode, domain)) statesToExit.add(stateNode);
--     }
--   }
DECLARE
  transition_domain_lca ltree;
  sanitized_source ltree;
  state_node ltree;
  exit_set TEXT[] := ARRAY[]::TEXT[];
  child_exit TEXT[] := ARRAY[]::TEXT[];
  combined TEXT[];
BEGIN
  IF transition_record IS NULL OR state_node_set IS NULL THEN
    RETURN ARRAY[]::TEXT[];
  END IF;

  -- if (t.target?.length): a targetless transition exits nothing; XState only
  -- runs its actions (#506).
  IF COALESCE(array_length(transition_record.computed_sanitized_target_ltree_array, 1), 0) = 0 THEN
    RETURN ARRAY[]::TEXT[];
  END IF;

  -- const domain = getTransitionDomain(t, historyValue): stored by the loader
  -- in computed_transition_domain_lca (get_transition_domain_v2). NULL means
  -- no domain (a re-entering transition at the root).
  transition_domain_lca := transition_record.computed_transition_domain_lca;
  sanitized_source := transition_record.computed_sanitized_source_ltree;

  -- if (t.reenter && t.source === domain) statesToExit.add(domain)
  IF COALESCE(transition_record.reenter, false) AND sanitized_source = transition_domain_lca THEN
    exit_set := exit_set || transition_domain_lca::TEXT;
  END IF;

  -- for (const stateNode of stateNodeSet) {
  --   if (isDescendant(stateNode, domain)) statesToExit.add(stateNode);
  -- }
  -- The domain itself stays active unless the transition re-enters it (added
  -- above); no domain (NULL) exits every active state (#506).
  --
  -- Written as a loop to match XState line by line. The same filter as one
  -- query (no faster for an instance's handful of active states):
  --   SELECT COALESCE(array_agg(st::TEXT), ARRAY[]::TEXT[]) INTO child_exit
  --   FROM unnest(fsm_core.sanitize_text_array_to_ltree_array(input_array := state_node_set)) AS st
  --   WHERE fsm_core.is_descendant(input_child := st, input_parent := transition_domain_lca);
  FOREACH state_node IN ARRAY COALESCE(fsm_core.sanitize_text_array_to_ltree_array(input_array := state_node_set), ARRAY[]::ltree[]) LOOP
    IF fsm_core.is_descendant(input_child := state_node, input_parent := transition_domain_lca) THEN
      child_exit := child_exit || state_node::TEXT;
    END IF;
  END LOOP;

  -- statesToExit is a Set: combine and deduplicate.
  combined := exit_set || child_exit;
  SELECT array_agg(DISTINCT x) INTO combined FROM unnest(combined) AS x WHERE x IS NOT NULL;

  RETURN COALESCE(combined, ARRAY[]::TEXT[]);
END;
$$ LANGUAGE plpgsql IMMUTABLE;



-- compute_exit_actions_v2 (the exit set and its actions) became part of
-- exit_states_v2, which is the whole of XState's exitStates (#518).
DROP FUNCTION IF EXISTS fsm_core.compute_exit_actions_v2(fsm_core.fsm_transitions, TEXT[], TEXT, TEXT);

CREATE OR REPLACE FUNCTION fsm_core.exit_states_v2(
    transition_record fsm_core.fsm_transitions,
    state_node_set TEXT[],
    fsm_name_param TEXT,
    fsm_version_param TEXT
)
RETURNS JSONB AS $$
-- XState's exitStates (packages/core/src/stateUtils.ts) for one transition:
--
--   const statesToExit = computeExitSet(transitions, mutStateNodeSet, historyValue);
--   statesToExit.sort((a, b) => b.order - a.order);
--   // (record history for each exited state's history children)
--   for (const s of statesToExit) {
--     ... [...s.exit, ...s.invoke.map((def) => stopChild(def.id))] ...
--     mutStateNodeSet.delete(s);
--   }
--
-- Returns exit_nodes (statesToExit), exit_actions in that order, and
-- state_node_set (mutStateNodeSet after the exits), which microstep_v2 passes
-- to enter_states_v2. History states are not supported, so nothing is
-- recorded for them.
DECLARE
    exit_nodes TEXT[];
    exit_actions JSONB;
    remaining_state_nodes TEXT[];
BEGIN
    -- No transition: nothing exits.
    IF transition_record IS NULL THEN
        RETURN jsonb_build_object(
            'exit_nodes', '[]'::jsonb,
            'exit_actions', '[]'::jsonb,
            'state_node_set', to_jsonb(COALESCE(state_node_set, ARRAY[]::TEXT[]))
        );
    END IF;

    -- const statesToExit = computeExitSet(transitions, mutStateNodeSet, historyValue);
    exit_nodes := COALESCE(
        fsm_core.compute_full_exit_set_v2(transition_record := transition_record, state_node_set := state_node_set),
        ARRAY[]::TEXT[]
    );

    -- statesToExit.sort((a, b) => b.order - a.order), then per state its exit
    -- actions and a stopChild per invoke: get_exit_actions_v2 returns them in
    -- that order (fsm_order DESC, exit before invoke).
    exit_actions := fsm_core.get_exit_actions_v2(
        input_state_paths := exit_nodes,
        input_fsm_name := fsm_name_param,
        input_fsm_version := fsm_version_param
    )->'actions';

    -- mutStateNodeSet.delete(s), for each state exited
    remaining_state_nodes := ARRAY(
        SELECT s FROM unnest(COALESCE(state_node_set, ARRAY[]::TEXT[])) AS s
        WHERE NOT (s = ANY(exit_nodes))
    );

    RETURN jsonb_build_object(
        'exit_nodes', to_jsonb(exit_nodes),
        'exit_actions', COALESCE(exit_actions, '[]'::jsonb),
        'state_node_set', to_jsonb(remaining_state_nodes)
    );
END;
$$ LANGUAGE plpgsql;



DROP FUNCTION IF EXISTS test_event_transition_for_exit_v2;
CREATE OR REPLACE FUNCTION test_event_transition_for_exit_v2(event_name TEXT, input_state_node_set TEXT[], fsm_name_param TEXT, fsm_version_param TEXT)
RETURNS JSONB AS $$
DECLARE
    transition_record fsm_core.fsm_transitions;
    transition_json JSONB;
    result JSONB;
BEGIN
    -- Find single record from fsm_core.fsm_transitions based on event_type, fsm_name, and fsm_version
    SELECT * INTO transition_record
    FROM fsm_core.fsm_transitions 
    WHERE event_type = event_name 
      AND fsm_name = fsm_name_param 
      AND fsm_version = fsm_version_param
    LIMIT 1;


    SELECT fsm_core.exit_states_v2(transition_record := transition_record, state_node_set := input_state_node_set, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param) INTO result;


    RETURN result;
END;
$$ LANGUAGE plpgsql;

SELECT test_event_transition_for_exit_v2('allstepfinished', 
                  ARRAY['machine',
                  'machine.creditCheck',
                  'machine.creditCheck.CheckingCreditScores',
                  'machine.creditCheck.CheckingCreditScores.CheckingEquiGavin',
                  'machine.creditCheck.CheckingCreditScores.CheckingEquiGavin.CheckingForExistingReport',
                  'machine.creditCheck.CheckingCreditScores.CheckingGavUnion',
                  'machine.creditCheck.CheckingCreditScores.CheckingGavUnion.CheckingForExistingReport',
                  'machine.creditCheck.CheckingCreditScores.CheckingGavperian',
                  'machine.creditCheck.CheckingCreditScores.CheckingGavperian.CheckingForExistingReport'
                  ], 
                  'creditCheck', 
                  'v3');