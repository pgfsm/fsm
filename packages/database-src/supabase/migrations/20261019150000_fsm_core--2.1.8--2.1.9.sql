set check_function_bodies = off;

-- SPEC-010 (a) and (b), #518 / #519: enterStates' done.state events and
-- completion, and the per-instance internal event queue.
-- * One SQL function per XState function: exit_states_v2 is exitStates
--   (compute_exit_actions_v2 is folded in), compute_entry_set_v2 is
--   computeEntrySet (compute_entry_actions_v2, renamed, without the actions),
--   enter_states_v2 is enterStates (its actions, and the done.state events
--   is_in_final_state_v2 decides), and microstep_v2 calls them as XState's
--   microstep does, returning raised_events and, when the machine is done,
--   every active state's exit actions.
-- * fsm_instance gets an internal event queue and a counter; the archive
--   appends raised events, takes the head of the queue for an internal
--   event, caps a cycle, and logs internal events with event_source.
ALTER TABLE fsm_core.fsm_instance
    ADD COLUMN internal_event_queue jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN internal_event_count integer NOT NULL DEFAULT 0;
COMMENT ON COLUMN fsm_core.fsm_instance.internal_event_queue IS
  'Events raised by the instance''s own microsteps (xstate.done.state.<id>), oldest first. The sync worker takes the head before reading the instance''s pgmq queue; the archive appends to it and removes the head in the same transaction as the state. Cleared when the instance stops being active.';
COMMENT ON COLUMN fsm_core.fsm_instance.internal_event_count IS
  'Internal events processed since the last event from the pgmq queue. Past 100 the instance is set to error (an infinite loop).';

ALTER TABLE fsm_core.fsm_instance_queue_event_logs
    ADD COLUMN event_source text NOT NULL DEFAULT 'queue' CHECK (event_source IN ('queue', 'internal'));

DROP FUNCTION IF EXISTS fsm_core.compute_exit_actions_v2(fsm_core.fsm_transitions, text[], text, text);

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

CREATE OR REPLACE FUNCTION public.test_event_transition_for_exit_v2(event_name TEXT, input_state_node_set TEXT[], fsm_name_param TEXT, fsm_version_param TEXT)
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

DROP FUNCTION IF EXISTS fsm_core.compute_entry_actions_v2(fsm_core.fsm_transitions, text, text, boolean);

CREATE OR REPLACE FUNCTION fsm_core.compute_entry_set_v2(transition_record fsm_core.fsm_transitions, fsm_name_param TEXT, fsm_version_param TEXT, is_initial_transition BOOLEAN)
RETURNS JSONB AS $$
-- XState's computeEntrySet (packages/core/src/stateUtils.ts) for one
-- transition:
--
--   for (const t of transitions) {
--     const domain = getTransitionDomain(t, historyValue);
--     for (const s of t.target || []) {                        // Part 1
--       if (t.source !== s || t.source !== domain || t.reenter) {
--         statesToEnter.add(s);
--         statesForDefaultEntry.add(s);
--       }
--       addDescendantStatesToEnter(s, historyValue, statesForDefaultEntry, statesToEnter);
--     }
--     for (const s of getEffectiveTargetStates(t, historyValue)) {  // Part 2
--       const ancestors = getProperAncestors(s, domain);
--       if (domain?.type === 'parallel') ancestors.push(domain);
--       addAncestorStatesToEnter(statesToEnter, historyValue, statesForDefaultEntry,
--         ancestors, !t.source.parent && t.reenter ? undefined : domain);
--     }
--   }
--
-- Returned as lists: states_to_enter (statesToEnter) and
-- states_for_default_entry (statesForDefaultEntry), for enter_states_v2. The
-- domain is the stored computed_transition_domain_lca
-- (get_transition_domain_v2). History states are not supported.
DECLARE
    sanitized_source_ltree LTREE;
    sanitized_target_ltree_array LTREE[];
    sanitized_target_state TEXT;
    transition_domain_lca ltree;
    reenter_flag BOOLEAN;
    effective_target_states_ltree_array LTREE[];
    sanitized_effective_target_state TEXT;
    ancestors TEXT[];
    ancestors_result RECORD;
    domain_type TEXT;
    source_is_root BOOLEAN;
    child_result RECORD;
    states_to_enter TEXT[];
    states_for_default_entry TEXT[];
    root_path ltree;
    final_result JSONB;
BEGIN

    -- The initial step. XState's initialMicrostep runs this same computeEntrySet
    -- with a synthetic transition:
    --
    --   { target: [...getInitialStateNodes(root)], source: root, reenter: true, actions: [] }
    --
    -- It has no domain (it re-enters, and the root has no proper ancestor), so
    -- every target is entered and is a default entry, and the descendant and
    -- ancestor steps add nothing new: the targets are the root and its whole
    -- initial chain. So the result is just getInitialStateNodes(root), which
    -- fsm_get_initial_state_nodes_v2 computes directly.
    --
    -- Why not build that synthetic transition and run it through the general
    -- path below, as XState does: the answer is already known, and the first
    -- event of every instance would then depend on all of the general entry
    -- code (descendants, ancestors, reentrancy) and its queries, for nothing.
    IF is_initial_transition THEN
          SELECT fs.computed_state_key_ltree INTO root_path
          FROM fsm_core.fsm_states fs
          WHERE fs.fsm_name = fsm_name_param
            AND fs.fsm_version = fsm_version_param
            AND fs.parent_node IS NULL;
          -- statesToEnter = getInitialStateNodes(root): the root, a compound's
          -- initial target, and every child of a parallel state, recursively.
          states_to_enter := COALESCE(
              fsm_core.fsm_get_initial_state_nodes_v2(input_fsm_name := fsm_name_param, input_fsm_version := fsm_version_param, input_state_path := root_path),
              ARRAY[]::TEXT[]
          );

          RETURN jsonb_build_object(
                'states_to_enter', states_to_enter,
                -- Every target is a default entry, the root included
                -- (enterStates' `if (isInitial)
                -- statesForDefaultEntry.add(machine.root)`), so each one's
                -- initial actions run.
                'states_for_default_entry', states_to_enter
          );
    END IF;
    
    -- No transition: nothing is entered.
    IF transition_record IS NULL THEN
        RETURN jsonb_build_object(
            'states_to_enter', '[]'::jsonb,
            'states_for_default_entry', '[]'::jsonb
        );
    END IF;
    
    
    sanitized_source_ltree := transition_record.computed_sanitized_source_ltree;
   
    sanitized_target_ltree_array := transition_record.computed_sanitized_target_ltree_array;
   

    RAISE NOTICE 'Skipped Calculating Transition Domain LCA from transition_record: %', transition_record;

    RAISE NOTICE 'Fetching Transition Domain LCA from transition_record: %', transition_record;

    transition_domain_lca := transition_record.computed_transition_domain_lca;


    reenter_flag := COALESCE((transition_record.reenter)::BOOLEAN, FALSE);
    
    -- Part 1: for (const s of t.target || []) { ... }
    RAISE NOTICE 'sanitized_target_ltree_array: %', sanitized_target_ltree_array;
    IF sanitized_target_ltree_array IS NOT NULL AND array_length(sanitized_target_ltree_array, 1) > 0 THEN
        FOR sanitized_target_state IN SELECT unnest(sanitized_target_ltree_array)
        LOOP
            
            IF (
                -- if (t.source !== s || t.source !== domain || t.reenter):
                -- if the target is different than the source then it will *definitely* be entered
                sanitized_source_ltree::TEXT != sanitized_target_state::TEXT OR
                -- we know that the domain can't lie within the source
                -- if it's different than the source then it's outside of it and it means that the target has to be entered as well
                sanitized_source_ltree::TEXT != transition_domain_lca::TEXT OR
                -- reentering transitions always enter the target, even if it's the source itself
                reenter_flag
            ) THEN
                
                
                    states_to_enter := array_append(states_to_enter, sanitized_target_state);
                
                    states_for_default_entry := array_append(states_for_default_entry, sanitized_target_state);
                
                    RAISE NOTICE 'states_to_enter: %', states_to_enter;
            END IF;

            RAISE NOTICE 'Before fsm_core.get_descendant_states_for_entry_v2 for sanitized_target_state: %', sanitized_target_state;
            RAISE NOTICE 'states_to_enter: %', states_to_enter;
            RAISE NOTICE 'states_for_default_entry: %', states_for_default_entry;
            
            -- addDescendantStatesToEnter(s, historyValue, statesForDefaultEntry, statesToEnter);
            child_result := fsm_core.get_descendant_states_for_entry_v2(input_state_id := sanitized_target_state::text, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param);
            RAISE NOTICE 'After fsm_core.get_descendant_states_for_entry_v2 for sanitized_target_state: %', sanitized_target_state;
            RAISE NOTICE 'child_result: %', child_result;
            states_to_enter := array_cat(states_to_enter, child_result.descendant_states_to_enter);
            states_for_default_entry := array_cat(states_for_default_entry, child_result.descendant_states_for_default_entry);
            RAISE NOTICE 'states_to_enter: %', states_to_enter;
            RAISE NOTICE 'states_for_default_entry: %', states_for_default_entry;
        END LOOP;
    END IF;

    -- Part 2: for (const s of getEffectiveTargetStates(t, historyValue)) { ... }

    SELECT type INTO domain_type FROM fsm_core.fsm_states
                WHERE computed_state_key_ltree = transition_domain_lca
                  AND fsm_name = fsm_name_param
                  AND fsm_version = fsm_version_param;
    

    -- getEffectiveTargetStates(t, historyValue): the targets themselves; history
    -- states, which it would resolve, are not supported.
    effective_target_states_ltree_array = transition_record.computed_sanitized_target_ltree_array;
    RAISE NOTICE 'effective_target_states_ltree_array: %', effective_target_states_ltree_array;

    -- !t.source.parent: the transition's source is the root (#506).
    source_is_root := EXISTS (
        SELECT 1 FROM fsm_core.fsm_states fs
        WHERE fs.fsm_name = fsm_name_param
          AND fs.fsm_version = fsm_version_param
          AND fs.computed_state_key_ltree = sanitized_source_ltree
          AND fs.parent_node IS NULL
    );

    IF effective_target_states_ltree_array IS NOT NULL AND array_length(effective_target_states_ltree_array, 1) > 0 THEN
        FOR sanitized_effective_target_state IN SELECT unnest(effective_target_states_ltree_array)
        LOOP

            -- const ancestors = getProperAncestors(s, domain);
            IF transition_domain_lca IS NULL THEN
                -- No domain: getProperAncestors(s, undefined) is every ancestor
                -- state, the root included, nearest first. get_proper_ancestors
                -- stops at once on a NULL end, and walking the path would also
                -- yield the labels of a root id with dots, so take them from
                -- the FSM's states (#506).
                SELECT COALESCE(array_agg(fs.computed_state_key_ltree::TEXT ORDER BY nlevel(fs.computed_state_key_ltree) DESC), ARRAY[]::TEXT[])
                INTO ancestors
                FROM fsm_core.fsm_states fs
                WHERE fs.fsm_name = fsm_name_param
                  AND fs.fsm_version = fsm_version_param
                  AND fsm_core.is_descendant(input_child := sanitized_effective_target_state::ltree, input_parent := fs.computed_state_key_ltree);
            ELSE
                ancestors := fsm_core.get_proper_ancestors(state_path_ltree := sanitized_effective_target_state::TEXT, to_state_path_ltree := transition_domain_lca::TEXT);
            END IF;

            -- if (domain?.type === 'parallel') ancestors.push(domain);
            IF domain_type = 'parallel' THEN
                ancestors := array_append(ancestors, transition_domain_lca::TEXT);
            END IF;

            
            -- addAncestorStatesToEnter(statesToEnter, historyValue,
            --   statesForDefaultEntry, ancestors, reentrancyDomain)
            ancestors_result := fsm_core.get_ancestor_states_for_entry_v2(
                ancestors := ancestors,
                -- !t.source.parent && t.reenter ? undefined : domain (#506)
                reentrancy_domain := CASE WHEN source_is_root AND reenter_flag THEN NULL ELSE transition_domain_lca::TEXT END,
                fsm_name_param := fsm_name_param,
                fsm_version_param := fsm_version_param
            );

            states_to_enter := array_cat(states_to_enter, ancestors_result.ancestor_states_to_enter);
            -- Regions of a parallel ancestor entered on the way also enter their
            -- initial states by default (addAncestorStatesToEnter calls
            -- addDescendantStatesToEnter with statesForDefaultEntry), so those
            -- states' initial actions run too (#506).
            states_for_default_entry := array_cat(states_for_default_entry, ancestors_result.ancestor_states_for_default_entry);

        END LOOP;
    END IF;

    RAISE NOTICE 'Final states_to_enter before dedup: %', states_to_enter;
    RAISE NOTICE 'Final states_for_default_entry before dedup: %', states_for_default_entry;
  
    
    -- Empty arrays, not JSON null, when nothing is entered (a targetless
    -- transition): enter_states_v2 expands states_to_enter (#506).
    final_result := jsonb_build_object(
        'states_to_enter', COALESCE(to_jsonb(states_to_enter), '[]'::jsonb),
        'states_for_default_entry', COALESCE(to_jsonb(states_for_default_entry), '[]'::jsonb)
    );

    RETURN final_result;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fsm_core.is_in_final_state_v2(
    state_node_set TEXT[],
    state_path TEXT,
    fsm_name_param TEXT,
    fsm_version_param TEXT
)
RETURNS BOOLEAN AS $$
-- XState's isInFinalState (packages/core/src/stateUtils.ts):
--
--   if (stateNode.type === 'compound') {
--     return getChildren(stateNode).some((s) => s.type === 'final' && stateNodeSet.has(s));
--   }
--   if (stateNode.type === 'parallel') {
--     return getChildren(stateNode).every((sn) => isInFinalState(stateNodeSet, sn));
--   }
--   return stateNode.type === 'final';
--
-- getChildren skips history states. A state's children are the rows whose
-- parent_node is its key path.
DECLARE
    node fsm_core.fsm_states;
    child fsm_core.fsm_states;
BEGIN
    SELECT * INTO node
    FROM fsm_core.fsm_states fs
    WHERE fs.fsm_name = fsm_name_param
      AND fs.fsm_version = fsm_version_param
      AND fs.computed_state_key_ltree::TEXT = state_path;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    IF node.type = 'compound' THEN
        FOR child IN
            SELECT * FROM fsm_core.fsm_states fs
            WHERE fs.fsm_name = fsm_name_param
              AND fs.fsm_version = fsm_version_param
              AND fs.parent_node = state_path
              AND fs.type <> 'history'
        LOOP
            IF child.type = 'final' AND child.computed_state_key_ltree::TEXT = ANY(state_node_set) THEN
                RETURN TRUE;
            END IF;
        END LOOP;
        RETURN FALSE;
    END IF;

    IF node.type = 'parallel' THEN
        FOR child IN
            SELECT * FROM fsm_core.fsm_states fs
            WHERE fs.fsm_name = fsm_name_param
              AND fs.fsm_version = fsm_version_param
              AND fs.parent_node = state_path
              AND fs.type <> 'history'
        LOOP
            IF NOT fsm_core.is_in_final_state_v2(state_node_set, child.computed_state_key_ltree::TEXT, fsm_name_param, fsm_version_param) THEN
                RETURN FALSE;
            END IF;
        END LOOP;
        RETURN TRUE;
    END IF;

    RETURN node.type = 'final';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fsm_core.enter_states_v2(
    transition_record fsm_core.fsm_transitions,
    state_node_set TEXT[],
    is_initial BOOLEAN,
    fsm_name_param TEXT,
    fsm_version_param TEXT
)
RETURNS JSONB AS $$
-- XState's enterStates (packages/core/src/stateUtils.ts) for one transition:
--
--   computeEntrySet(filteredTransitions, historyValue, statesForDefaultEntry, statesToEnter);
--   if (isInitial) statesForDefaultEntry.add(snapshot.machine.root);
--   const completedNodes = new Set();
--   for (const stateNodeToEnter of [...statesToEnter].sort((a, b) => a.order - b.order)) {
--     mutStateNodeSet.add(stateNodeToEnter);
--     actions.push(...stateNodeToEnter.entry, spawnChild per invoke,
--                  ...initial.actions if statesForDefaultEntry.has(stateNodeToEnter));
--     if (stateNodeToEnter.type === 'final') {
--       const parent = stateNodeToEnter.parent;
--       let ancestorMarker = parent?.type === 'parallel' ? parent : parent?.parent;
--       if (parent?.type === 'compound') {
--         internalQueue.push(createDoneStateEvent(parent!.id, ...output));
--       }
--       while (ancestorMarker?.type === 'parallel' && !completedNodes.has(ancestorMarker)
--              && isInFinalState(mutStateNodeSet, ancestorMarker)) {
--         completedNodes.add(ancestorMarker);
--         internalQueue.push(createDoneStateEvent(ancestorMarker.id));
--         ancestorMarker = ancestorMarker.parent;
--       }
--       if (ancestorMarker) continue;
--       nextSnapshot = cloneMachineSnapshot(nextSnapshot, { status: 'done', ... });
--     }
--   }
--
-- compute_entry_set_v2 is computeEntrySet. The loop goes through the states to
-- enter as XState's does: adds each to the active states, collects its actions
-- and, for a final state, raises its done.state events and decides done
-- (SPEC-010, #518). Each state is added before its check, so when two regions
-- finish in one microstep their parallel state is done only at the second, and
-- raises once. The actions are returned for the sync worker to run: a state's
-- entry actions and a spawnChild per invoke in entry_actions, its initial
-- actions in initial_actions (the worker puts each after its state's entry
-- actions, orderEntryActions).
--
-- state_node_set is the active states after exitStates (exit_states_v2).
-- Returns states_to_enter, entry_actions, initial_actions, state_node_set
-- (mutStateNodeSet afterwards, sorted), raised_events
-- ([{eventType: xstate.done.state.<state id>}], without a final state's
-- output, a function that isn't in fsm.json) and done (a final state was
-- entered and no enclosing state is left to finish: the machine itself is
-- done).
DECLARE
    entry_set JSONB;
    states_to_enter TEXT[];
    states_for_default_entry TEXT[];
    entry_actions JSONB := '[]'::jsonb;
    initial_actions JSONB := '[]'::jsonb;
    mut_state_node_set TEXT[] := COALESCE(state_node_set, ARRAY[]::TEXT[]);
    completed_nodes TEXT[] := ARRAY[]::TEXT[];
    raised_events JSONB := '[]'::jsonb;
    is_done BOOLEAN := FALSE;
    state_to_enter fsm_core.fsm_states;
    parent fsm_core.fsm_states;
    ancestor_marker fsm_core.fsm_states;
    has_parent BOOLEAN;
    has_ancestor_marker BOOLEAN;
BEGIN
    -- computeEntrySet(filteredTransitions, historyValue, statesForDefaultEntry, statesToEnter);
    -- if (isInitial) statesForDefaultEntry.add(snapshot.machine.root): on the
    -- initial step compute_entry_set_v2 already counts the root as one.
    entry_set := fsm_core.compute_entry_set_v2(
        transition_record := transition_record,
        fsm_name_param := fsm_name_param,
        fsm_version_param := fsm_version_param,
        is_initial_transition := is_initial
    );
    states_to_enter := ARRAY(SELECT jsonb_array_elements_text(COALESCE(entry_set->'states_to_enter', '[]'::jsonb)));
    states_for_default_entry := ARRAY(SELECT jsonb_array_elements_text(COALESCE(entry_set->'states_for_default_entry', '[]'::jsonb)));

    -- [...statesToEnter].sort((a, b) => a.order - b.order)
    FOR state_to_enter IN
        SELECT * FROM fsm_core.fsm_states fs
        WHERE fs.fsm_name = fsm_name_param
          AND fs.fsm_version = fsm_version_param
          AND fs.computed_state_key_ltree::TEXT = ANY(states_to_enter)
        ORDER BY fs.fsm_order ASC
    LOOP
        -- mutStateNodeSet.add(stateNodeToEnter)
        IF NOT (state_to_enter.computed_state_key_ltree::TEXT = ANY(mut_state_node_set)) THEN
            mut_state_node_set := array_append(mut_state_node_set, state_to_enter.computed_state_key_ltree::TEXT);
        END IF;

        -- actions.push(...stateNodeToEnter.entry), and a spawnChild per invoke
        entry_actions := entry_actions || fsm_core.get_entry_actions_v2(
            input_state_paths := ARRAY[state_to_enter.computed_state_key_ltree::TEXT],
            input_fsm_name := fsm_name_param,
            input_fsm_version := fsm_version_param
        );
        -- if (statesForDefaultEntry.has(stateNodeToEnter)) actions.push(...initial.actions)
        IF state_to_enter.computed_state_key_ltree::TEXT = ANY(states_for_default_entry) THEN
            initial_actions := initial_actions || fsm_core.get_initial_actions_v2(
                input_state_paths := ARRAY[state_to_enter.computed_state_key_ltree::TEXT],
                input_fsm_name := fsm_name_param,
                input_fsm_version := fsm_version_param
            );
        END IF;

        -- if (stateNodeToEnter.type === 'final')
        CONTINUE WHEN state_to_enter.type <> 'final';

        -- const parent = stateNodeToEnter.parent;
        SELECT * INTO parent FROM fsm_core.fsm_states fs
        WHERE fs.fsm_name = fsm_name_param
          AND fs.fsm_version = fsm_version_param
          AND fs.computed_state_key_ltree::TEXT = state_to_enter.parent_node;
        has_parent := FOUND;

        -- let ancestorMarker = parent?.type === 'parallel' ? parent : parent?.parent;
        has_ancestor_marker := FALSE;
        IF has_parent AND parent.type = 'parallel' THEN
            ancestor_marker := parent;
            has_ancestor_marker := TRUE;
        ELSIF has_parent THEN
            SELECT * INTO ancestor_marker FROM fsm_core.fsm_states fs
            WHERE fs.fsm_name = fsm_name_param
              AND fs.fsm_version = fsm_version_param
              AND fs.computed_state_key_ltree::TEXT = parent.parent_node;
            has_ancestor_marker := FOUND;
        END IF;

        -- if (parent?.type === 'compound') internalQueue.push(createDoneStateEvent(parent.id))
        IF has_parent AND parent.type = 'compound' THEN
            raised_events := raised_events || jsonb_build_array(jsonb_build_object('eventType', 'xstate.done.state.' || parent.id));
        END IF;

        -- while (ancestorMarker?.type === 'parallel' && !completedNodes.has(ancestorMarker)
        --        && isInFinalState(mutStateNodeSet, ancestorMarker))
        WHILE has_ancestor_marker
            AND ancestor_marker.type = 'parallel'
            AND NOT (ancestor_marker.computed_state_key_ltree::TEXT = ANY(completed_nodes))
            AND fsm_core.is_in_final_state_v2(mut_state_node_set, ancestor_marker.computed_state_key_ltree::TEXT, fsm_name_param, fsm_version_param)
        LOOP
            completed_nodes := array_append(completed_nodes, ancestor_marker.computed_state_key_ltree::TEXT);
            raised_events := raised_events || jsonb_build_array(jsonb_build_object('eventType', 'xstate.done.state.' || ancestor_marker.id));
            -- ancestorMarker = ancestorMarker.parent
            SELECT * INTO ancestor_marker FROM fsm_core.fsm_states fs
            WHERE fs.fsm_name = fsm_name_param
              AND fs.fsm_version = fsm_version_param
              AND fs.computed_state_key_ltree::TEXT = ancestor_marker.parent_node;
            has_ancestor_marker := FOUND;
        END LOOP;

        -- if (ancestorMarker) continue; otherwise the machine is done.
        CONTINUE WHEN has_ancestor_marker;
        is_done := TRUE;
    END LOOP;

    RETURN jsonb_build_object(
        'states_to_enter', to_jsonb(states_to_enter),
        'entry_actions', entry_actions,
        'initial_actions', initial_actions,
        'state_node_set', to_jsonb(ARRAY(
            SELECT DISTINCT x FROM unnest(mut_state_node_set || states_to_enter) AS x ORDER BY x
        )),
        'raised_events', raised_events,
        'done', is_done
    );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fsm_core.test_event_transition_for_entry_v2(event_name TEXT, fsm_name_param TEXT, fsm_version_param TEXT)
RETURNS JSONB AS $$
-- For debugging: what entering on event_name's first transition does, from
-- no active states (enter_states_v2).
DECLARE
    transition_record fsm_core.fsm_transitions;
BEGIN
    SELECT * INTO transition_record
    FROM fsm_core.fsm_transitions
    WHERE event_type = event_name
      AND fsm_name = fsm_name_param
      AND fsm_version = fsm_version_param
    LIMIT 1;

    RETURN fsm_core.enter_states_v2(
        transition_record := transition_record,
        state_node_set := ARRAY[]::TEXT[],
        is_initial := event_name = 'initialTransition_event',
        fsm_name_param := fsm_name_param,
        fsm_version_param := fsm_version_param
    );
END;
$$ LANGUAGE plpgsql;

REVOKE EXECUTE ON FUNCTION fsm_core.exit_states_v2(fsm_core.fsm_transitions, text[], text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fsm_core.compute_entry_set_v2(fsm_core.fsm_transitions, text, text, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fsm_core.is_in_final_state_v2(text[], text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fsm_core.enter_states_v2(fsm_core.fsm_transitions, text[], boolean, text, text) FROM PUBLIC;

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
--   const nextStateNodes = [...mutStateNodeSet];
--   if (nextState.status === 'done') {
--     nextState = resolveActionsAndContext(..., nextStateNodes
--       .sort((a, b) => b.order - a.order).flatMap((state) => state.exit));    // 4
--   }
--
-- exit_states_v2 and enter_states_v2 are exitStates and enterStates; the
-- active states (mutStateNodeSet) go from one to the other. Only one
-- transition is passed (no conflicts to remove), and the actions are returned
-- for the sync worker to run in that order instead of being run here. The
-- done.state events enterStates raises are returned as raised_events, for the
-- archive to put on the instance's internal event queue (SPEC-010, #518).
DECLARE
	transition_actions JSONB;
	exit_result JSONB;
	entry_result JSONB;
	updated_state_nodes TEXT[];
	is_done BOOLEAN;
	is_initial BOOLEAN;
	completion_exit_actions JSONB := '[]'::jsonb;
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
	is_done := (entry_result->>'done')::BOOLEAN;

	-- 4. if (nextState.status === 'done'): every active state's exit actions,
	--    deepest first. XState then stops the machine's children; here each
	--    state's invokes come back as stops too, for the sync worker to cancel
	--    their queued messages (get_exit_actions_v2, as when a state exits).
	IF is_done THEN
		completion_exit_actions := fsm_core.get_exit_actions_v2(
			input_state_paths := updated_state_nodes,
			input_fsm_name := fsm_name_param,
			input_fsm_version := fsm_version_param
		)->'actions';
	END IF;

	RETURN jsonb_build_object(
		'updated_state_value_node_set', updated_state_nodes,
		'updated_state_value', fsm_core.build_nested_json_recursive(paths := updated_state_nodes),
		'exit_actions', exit_result->'exit_actions',
		'entry_actions', entry_result->'entry_actions',
		'initial_actions', entry_result->'initial_actions',
		'transition_actions', transition_actions,
		'raised_events', entry_result->'raised_events',
		'done', is_done,
		'completion_exit_actions', COALESCE(completion_exit_actions, '[]'::jsonb)
	);
END;
$$ LANGUAGE plpgsql;

-- archive_event_from_fsm_type_worker_v2: saves one macrostep. The worker
-- passes the scheduled events and invokes to stop and to start, as items
-- from the compiled actions (each with its id; an invoke also with its src),
-- and the instance's current totals; the entries in those totals are what
-- send_event_to_fsm_queue_with_event_logs_v2 (schedules) and
-- start_invoked_async_operation_v2 (invokes) returned.
-- The reply-to parameters (send_to_parent_queue_id, _type, _event_name) are
-- gone: a parent is read from this instance's row (step 9, #523, #526).
--
-- The internal event queue (SPEC-010, #519): raised_events are the done.state
-- events microstep_v2 returned, appended to fsm_instance.internal_event_queue
-- in this transaction (step 6b). processed_internal_event is set when the
-- event processed now came from that queue instead of pgmq: it must be the
-- queue's head, which is removed, and no pgmq message is archived (step 8).
DROP FUNCTION IF EXISTS fsm_core.archive_event_from_fsm_type_worker_v2(
  text, bigint, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, uuid, text, text
);
DROP FUNCTION IF EXISTS fsm_core.archive_event_from_fsm_type_worker_v2(
  text, bigint, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb
);
CREATE OR REPLACE FUNCTION fsm_core.archive_event_from_fsm_type_worker_v2(
  remove_from_current_fsm_instance_queue_id text,
  remove_current_queue_msg_id bigint,
  to_be_removed_schedule_queue_msg_ids jsonb,
  to_be_removed_async_operation_queue_msg_ids jsonb,
  to_be_added_schedule_queue_data jsonb,
  to_be_added_async_operation_queue_data jsonb,
  input_total_schedule_queue_data jsonb,
  input_total_async_operation_queue_data jsonb,
  fsm_instance_data_save_fsm_status jsonb,
  fsm_instance_data_save_fsm_state jsonb,
  fsm_instance_data_save_fsm_context jsonb,
  fsm_instance_data_save_fsm_xstate_state jsonb,
  raised_events jsonb DEFAULT '[]'::jsonb,
  processed_internal_event jsonb DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
    i int;

    schedule_queue_entry jsonb;
    remove_schedule boolean;
    schedule_queue_message jsonb;
    confirmed_removed_schedule_queue_data jsonb[] := '{}';
    confirmed_match_for_schedule boolean;
    not_confirmed_removed_schedule_queue_data jsonb[] := '{}';

    async_operation_queue_entry jsonb;
    remove_async_operation boolean;
    async_operation_queue_message jsonb;
    confirmed_removed_async_operation_queue_data jsonb[] := '{}';
    confirmed_match_for_async_operation boolean;
    not_confirmed_removed_async_operation_queue_data jsonb[] := '{}';

    to_be_added_schedule_queue_data_entry jsonb;
    to_be_added_schedule_queue_data_entry_delay int;
    output_schedule_result jsonb;

    to_be_added_async_operation_queue_data_entry jsonb;
    output_async_operation_result jsonb;

    new_total_schedule_queue_data jsonb := '[]'::jsonb;
    new_total_async_operation_queue_data jsonb := '[]'::jsonb;

    confirmed_removed_schedule_queue_data_success jsonb[] := '{}';
    confirmed_removed_schedule_queue_data_failed jsonb[] := '{}';

    confirmed_removed_async_operation_queue_data_success jsonb[] := '{}';
    confirmed_removed_async_operation_queue_data_failed jsonb[] := '{}';

    added_schedule_queue_data jsonb[] := '{}';
    added_async_operation_queue_data jsonb[] := '{}';
    parent_notify_result jsonb;
    child_parent_fsm_instance_id uuid;
    child_parent_invoke_id text;
    child_parent_fsm_name text;
    child_parent_fsm_version text;

    -- SPEC-010's cycle cap: internal events in a row before the instance is
    -- set to error, so a cycle (an onDone that enters another final state that
    -- leads back) can't run forever.
    max_internal_events CONSTANT integer := 100;
    instance_fsm_type text;
    instance_fsm_version text;
    current_internal_event_queue jsonb;
    current_internal_event_count integer;
    new_internal_event_queue jsonb;
    new_internal_event_count integer;
    saved_status jsonb;
    saved_error jsonb;
    raised_event jsonb;
BEGIN
    -- 1. Remove the cancelled scheduled events from input_total_schedule_queue_data
    -- A = 'input_total_schedule_queue_data'
    -- B = 'to_be_removed_schedule_queue_msg_ids'
    -- C = 'confirmed_removed_schedule_queue_data' (used for canceling events) ( C = A intersect B )
    -- D = 'not_confirmed_removed_schedule_queue_data' (used for returning to caller) ( D = B - C )
    IF input_total_schedule_queue_data IS NOT NULL THEN
        new_total_schedule_queue_data := '[]'::jsonb;
        FOR schedule_queue_entry IN
            SELECT value FROM jsonb_array_elements(input_total_schedule_queue_data) value
        LOOP
            remove_schedule := false;
            -- The scheduled event being processed now has fired: drop its entry
            -- (its message is archived below as the current one, #516).
            CONTINUE WHEN (schedule_queue_entry->'queue_data'->>'queueMsgId')::bigint = remove_current_queue_msg_id;
            IF to_be_removed_schedule_queue_msg_ids IS NOT NULL THEN
                FOR i IN 0 .. jsonb_array_length(to_be_removed_schedule_queue_msg_ids)-1 LOOP
                    schedule_queue_message := to_be_removed_schedule_queue_msg_ids->i;

                    -- A cancel names the scheduled event (`id`, e.g.
                    -- xstate.after.1000.<state id>); an entry is what
                    -- send_event_to_fsm_queue_with_event_logs_v2 returned when it was
                    -- scheduled. The old keys (event.send_event_name_to_parent_queue_id,
                    -- schedule_queue_name) were never in an entry, so nothing was ever
                    -- cancelled (#516).
                    IF (
                        (schedule_queue_entry->'queue_data'->'eventData'->>'eventType')::text = (schedule_queue_message->>'id')::text
                    ) THEN
                        remove_schedule := true;

                        EXIT;
                    END IF;
                END LOOP;
            END IF;

            IF remove_schedule THEN
                confirmed_removed_schedule_queue_data := array_append(confirmed_removed_schedule_queue_data, schedule_queue_entry);
            ELSE
                -- jsonb, not a SQL array: append with || (array_append failed on every
                -- result, #495).
                new_total_schedule_queue_data := new_total_schedule_queue_data || jsonb_build_array(schedule_queue_entry);
            END IF;
        END LOOP;
    END IF;

    -- 1b. Derive not_confirmed_removed_schedule_queue_data
    -- D = B - C => not_confirmed_removed_schedule_queue_data = to_be_removed_schedule_queue_msg_ids - confirmed_removed_schedule_queue_data
    IF to_be_removed_schedule_queue_msg_ids IS NOT NULL THEN
        FOR i IN 0 .. jsonb_array_length(to_be_removed_schedule_queue_msg_ids)-1 LOOP
            schedule_queue_message := to_be_removed_schedule_queue_msg_ids->i;
            confirmed_match_for_schedule := false;
            FOREACH schedule_queue_entry IN ARRAY confirmed_removed_schedule_queue_data LOOP
                IF (
                    (schedule_queue_entry->'queue_data'->'eventData'->>'eventType')::text = (schedule_queue_message->>'id')::text
                ) THEN
                    confirmed_match_for_schedule := true;
                    EXIT;
                END IF;
            END LOOP;

            IF NOT confirmed_match_for_schedule THEN
                not_confirmed_removed_schedule_queue_data := array_append(not_confirmed_removed_schedule_queue_data, schedule_queue_message);
            END IF;
        END LOOP;
    END IF;


    -- 2. Remove the stopped invokes from input_total_async_operation_queue_data
    -- A = 'input_total_async_operation_queue_data'
    -- B = 'to_be_removed_async_operation_queue_msg_ids'
    -- C = 'confirmed_removed_async_operation_queue_data' (used for canceling events) ( C = A intersect B )
    -- D = 'not_confirmed_removed_async_operation_queue_data' (used for returning to caller) ( D = B - C )
    IF input_total_async_operation_queue_data IS NOT NULL THEN
        new_total_async_operation_queue_data := '[]'::jsonb;
        FOR async_operation_queue_entry IN
            SELECT value FROM jsonb_array_elements(input_total_async_operation_queue_data) value
        LOOP
            remove_async_operation := false;
            IF to_be_removed_async_operation_queue_msg_ids IS NOT NULL THEN
                FOR i IN 0 .. jsonb_array_length(to_be_removed_async_operation_queue_msg_ids)-1 LOOP
                    async_operation_queue_message := to_be_removed_async_operation_queue_msg_ids->i;

                    IF (
                        -- The invoke being stopped, by its id and src (an entry from
                        -- start_invoked_async_operation_v2, #526).
                        async_operation_queue_entry->>'invoke_id' = async_operation_queue_message->>'id'
                        AND async_operation_queue_entry->>'src' = async_operation_queue_message->>'src'
                    ) THEN
                        remove_async_operation := true;

                        EXIT;
                    END IF;
                END LOOP;
            END IF;

            IF remove_async_operation THEN
                confirmed_removed_async_operation_queue_data := array_append(confirmed_removed_async_operation_queue_data, async_operation_queue_entry);
            ELSE
                -- jsonb, not a SQL array: append with || (#495).
                new_total_async_operation_queue_data := new_total_async_operation_queue_data || jsonb_build_array(async_operation_queue_entry);
            END IF;
        END LOOP;
    END IF;

    -- 2b. Derive not_confirmed_removed_async_operation_queue_data
    -- D = B - C => not_confirmed_removed_async_operation_queue_data = to_be_removed_async_operation_queue_msg_ids - confirmed_removed_async_operation_queue_data
    IF to_be_removed_async_operation_queue_msg_ids IS NOT NULL THEN
        FOR i IN 0 .. jsonb_array_length(to_be_removed_async_operation_queue_msg_ids)-1 LOOP
            async_operation_queue_message := to_be_removed_async_operation_queue_msg_ids->i;
            confirmed_match_for_async_operation := false;
            FOREACH async_operation_queue_entry IN ARRAY confirmed_removed_async_operation_queue_data LOOP
                IF (
                    async_operation_queue_entry->>'invoke_id' = async_operation_queue_message->>'id'
                    AND async_operation_queue_entry->>'src' = async_operation_queue_message->>'src'
                ) THEN
                    confirmed_match_for_async_operation := true;
                    EXIT;
                END IF;
            END LOOP;

            IF NOT confirmed_match_for_async_operation THEN
                not_confirmed_removed_async_operation_queue_data := array_append(not_confirmed_removed_async_operation_queue_data, async_operation_queue_message);
            END IF;
        END LOOP;
    END IF;

    -- 3. Remove schedule queue messages.
    IF confirmed_removed_schedule_queue_data IS NOT NULL THEN
        FOR i IN 1 .. COALESCE(array_length(confirmed_removed_schedule_queue_data, 1), 0) LOOP
            schedule_queue_entry := confirmed_removed_schedule_queue_data[i];
            -- The scheduled message's id, as stored when it was sent (#516).
            PERFORM pgmq.archive(queue_name := remove_from_current_fsm_instance_queue_id, msg_id := (schedule_queue_entry->'queue_data'->>'queueMsgId')::bigint);
            confirmed_removed_schedule_queue_data_success := array_append(confirmed_removed_schedule_queue_data_success, schedule_queue_entry);
        END LOOP;
    END IF;

    -- 4. Cancel the stopped invokes' start messages: on the async operation's
    --    queue, or a child FSM's start event on its own queue.
    IF confirmed_removed_async_operation_queue_data IS NOT NULL THEN
        FOR i IN 1 .. COALESCE(array_length(confirmed_removed_async_operation_queue_data, 1), 0) LOOP
            async_operation_queue_entry := confirmed_removed_async_operation_queue_data[i];
            PERFORM fsm_core.cancel_event_for_fsm_async_operation_type_worker_v2(
                async_operation_type_worker_name := async_operation_queue_entry->>'queue_id',
                queue_msg_id := (async_operation_queue_entry->>'queue_msg_id')::bigint
            );
            confirmed_removed_async_operation_queue_data_success := array_append(confirmed_removed_async_operation_queue_data_success, async_operation_queue_entry);
        END LOOP;
    END IF;

    -- 5. Schedule the new delayed events and collect their entries
    IF to_be_added_schedule_queue_data IS NOT NULL THEN
        FOR i IN 0 .. jsonb_array_length(to_be_added_schedule_queue_data)-1 LOOP
            to_be_added_schedule_queue_data_entry := to_be_added_schedule_queue_data->i;
            to_be_added_schedule_queue_data_entry_delay := COALESCE((to_be_added_schedule_queue_data_entry->>'delay')::integer, 0) / 1000;
            output_schedule_result := fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
                input_fsm_instance_id := remove_from_current_fsm_instance_queue_id::uuid,
                input_fsm_instance_id_fsm_type := to_be_added_schedule_queue_data_entry->>'fsmType',
                input_fsm_instance_id_fsm_version := to_be_added_schedule_queue_data_entry->>'fsmVersion',
                input_event_name := to_be_added_schedule_queue_data_entry->>'id',
                input_event_action_type := to_be_added_schedule_queue_data_entry->>'action_type',
                input_event_data := to_be_added_schedule_queue_data_entry->'input',
                input_event_delay := to_be_added_schedule_queue_data_entry_delay,
                input_event_status := 'ACTIVE',
                input_event_output := '{}'::jsonb,
                input_error_message := NULL
            );
            added_schedule_queue_data := array_append(added_schedule_queue_data, output_schedule_result);
            new_total_schedule_queue_data := new_total_schedule_queue_data || output_schedule_result;
        END LOOP;
    END IF;

    -- 6. Start the invokes of the states entered, as XState's spawnChild
    --    does (#526), and collect their entries; each is kept until its
    --    invoking state exits.
    IF to_be_added_async_operation_queue_data IS NOT NULL THEN
        FOR i IN 0 .. jsonb_array_length(to_be_added_async_operation_queue_data)-1 LOOP
            to_be_added_async_operation_queue_data_entry := to_be_added_async_operation_queue_data->i;
            output_async_operation_result := fsm_core.start_invoked_async_operation_v2(
                invoke_id := to_be_added_async_operation_queue_data_entry->>'id',
                src := to_be_added_async_operation_queue_data_entry->>'src',
                input := to_be_added_async_operation_queue_data_entry->'input',
                action_type := to_be_added_async_operation_queue_data_entry->>'action_type',
                async_operation_type := to_be_added_async_operation_queue_data_entry->>'asyncOperationType',
                async_operation_version := to_be_added_async_operation_queue_data_entry->>'asyncOperationVersion',
                async_operation_language := to_be_added_async_operation_queue_data_entry->>'asyncOperationLanguage',
                parent_fsm_instance_id := remove_from_current_fsm_instance_queue_id::uuid,
                parent_fsm_name := to_be_added_async_operation_queue_data_entry->>'parentFsmName',
                parent_fsm_version := to_be_added_async_operation_queue_data_entry->>'parentFsmVersion'
            );
            added_async_operation_queue_data := array_append(added_async_operation_queue_data, output_async_operation_result);
            new_total_async_operation_queue_data := new_total_async_operation_queue_data || jsonb_build_array(output_async_operation_result);
        END LOOP;
    END IF;

    -- 6b. The internal event queue (SPEC-010, #519), read under the row lock.
    SELECT fi.fsm_type, fi.fsm_version, fi.internal_event_queue, fi.internal_event_count
    INTO instance_fsm_type, instance_fsm_version, current_internal_event_queue, current_internal_event_count
    FROM fsm_core.fsm_instance fi
    WHERE fi.id = remove_from_current_fsm_instance_queue_id::uuid
    FOR UPDATE;

    new_internal_event_queue := COALESCE(current_internal_event_queue, '[]'::jsonb);
    IF processed_internal_event IS NOT NULL THEN
        -- An internal event was processed: it is the head of the queue, as the
        -- worker took it. Anything else means the queue changed under it.
        IF new_internal_event_queue->0 IS DISTINCT FROM processed_internal_event THEN
            RAISE EXCEPTION 'internal event % is not the head of instance %''s internal event queue (head: %)',
                processed_internal_event, remove_from_current_fsm_instance_queue_id, new_internal_event_queue->0;
        END IF;
        new_internal_event_queue := new_internal_event_queue - 0;
        new_internal_event_count := COALESCE(current_internal_event_count, 0) + 1;
    ELSE
        -- An event from the pgmq queue starts a new count.
        new_internal_event_count := 0;
    END IF;

    saved_status := fsm_instance_data_save_fsm_status;
    IF new_internal_event_count > max_internal_events THEN
        saved_status := '"error"'::jsonb;
        saved_error := jsonb_build_object(
            'message', format('Infinite loop: more than %s internal events in a row (last: %s)',
                max_internal_events, processed_internal_event->>'eventType')
        );
    END IF;

    IF COALESCE(saved_status #>> '{}', 'active') = 'active' THEN
        -- internalQueue.push(...): this microstep's raised events go after the
        -- ones already waiting, each logged as an internal event.
        FOR raised_event IN SELECT value FROM jsonb_array_elements(COALESCE(raised_events, '[]'::jsonb)) value
        LOOP
            new_internal_event_queue := new_internal_event_queue || jsonb_build_array(raised_event);
            INSERT INTO fsm_core.fsm_instance_queue_event_logs (
                fsm_instance_id, fsm_instance_id_fsm_type, fsm_instance_id_fsm_version,
                event_name, event_data, event_delay, event_source, event_status, event_output
            ) VALUES (
                remove_from_current_fsm_instance_queue_id::uuid, instance_fsm_type, instance_fsm_version,
                raised_event->>'eventType', raised_event, 0, 'internal', 'ACTIVE', '{}'::jsonb
            );
        END LOOP;
    ELSE
        -- Done, error or stopped: like XState's macrostep, which only runs
        -- while the snapshot is active, nothing more is processed.
        new_internal_event_queue := '[]'::jsonb;
    END IF;

    -- 7. Save the instance: its new totals, status, state, context, XState
    --    snapshot and internal event queue
    UPDATE fsm_core.fsm_instance
    SET
        total_schedule_queue_data = new_total_schedule_queue_data,
        total_async_operation_queue_data = new_total_async_operation_queue_data,
        internal_event_queue = new_internal_event_queue,
        internal_event_count = new_internal_event_count,
        fsm_instance_error = COALESCE(saved_error, fsm_instance_error),
        fsm_instance_status = saved_status,
        fsm_instance_state = fsm_instance_data_save_fsm_state,
        fsm_instance_context = fsm_instance_data_save_fsm_context,
        fsm_instance_xstate_state = fsm_instance_data_save_fsm_xstate_state
    WHERE id = remove_from_current_fsm_instance_queue_id::uuid;

    -- 8. Archive the pgmq message this macrostep processed. An internal event
    --    was removed from the internal queue instead (6b).
    IF processed_internal_event IS NULL THEN
        PERFORM pgmq.archive(queue_name := remove_from_current_fsm_instance_queue_id, msg_id := remove_current_queue_msg_id::bigint);
    END IF;

    -- 9. If this instance was invoked by a parent FSM and has finished, tell the
    --    parent, as XState does for a child actor (#523):
    --    xstate.done.actor.<invoke id> when done, xstate.error.actor.<invoke id>
    --    on error, nothing when stopped. The parent comes from this instance's row
    --    (set when it was invoked): the message processed now is usually not the
    --    one that started it.
    SELECT fi.parent_fsm_instance_id, fi.parent_invoke_id
    INTO child_parent_fsm_instance_id, child_parent_invoke_id
    FROM fsm_core.fsm_instance fi
    WHERE fi.id = remove_from_current_fsm_instance_queue_id::uuid;

    IF child_parent_fsm_instance_id IS NOT NULL
        AND (saved_status #>> '{}') IN ('done', 'completed', 'final', 'error')
    THEN
        SELECT p.fsm_name, p.fsm_version
        INTO child_parent_fsm_name, child_parent_fsm_version
        FROM fsm_core.fsm_instance p
        WHERE p.id = child_parent_fsm_instance_id;

        parent_notify_result := fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
            input_fsm_instance_id              := child_parent_fsm_instance_id,
            input_fsm_instance_id_fsm_type     := child_parent_fsm_name,
            input_fsm_instance_id_fsm_version  := child_parent_fsm_version,
            input_event_name                   := CASE
                                                      WHEN (saved_status #>> '{}') = 'error'
                                                      THEN 'xstate.error.actor.'
                                                      ELSE 'xstate.done.actor.'
                                                  END || child_parent_invoke_id,
            input_event_action_type            := 'childFsm_completed',
            input_event_data                   := fsm_instance_data_save_fsm_context,
            input_event_delay                  := 0,
            input_event_status                 := 'ACTIVE',
            input_event_output                 := '{}'::jsonb,
            input_error_message                := NULL
        );
    END IF;

    RETURN jsonb_build_object(
         'confirmed_removed_schedule_queue_data_success', confirmed_removed_schedule_queue_data_success,
         'confirmed_removed_async_operation_queue_data_success', confirmed_removed_async_operation_queue_data_success,

         'confirmed_removed_schedule_queue_data_failed', confirmed_removed_schedule_queue_data_failed,
         'confirmed_removed_async_operation_queue_data_failed', confirmed_removed_async_operation_queue_data_failed,

         'not_confirmed_removed_schedule_queue_data', not_confirmed_removed_schedule_queue_data,
         'not_confirmed_removed_async_operation_queue_data', not_confirmed_removed_async_operation_queue_data,

         'added_schedule_queue_data', added_schedule_queue_data,
         'added_async_operation_queue_data', added_async_operation_queue_data,

         'new_total_schedule_queue_data', new_total_schedule_queue_data,
         'new_total_async_operation_queue_data', new_total_async_operation_queue_data,

         'old_total_schedule_queue_data', input_total_schedule_queue_data,
         'old_total_async_operation_queue_data', input_total_async_operation_queue_data,
         'internal_event_queue', new_internal_event_queue,
         'internal_event_count', new_internal_event_count,
         'parent_notify_result', parent_notify_result
      );

END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION fsm_core.archive_event_from_fsm_type_worker_v2(text, bigint, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
REVOKE EXECUTE ON FUNCTION fsm_core.archive_event_from_fsm_type_worker_v2(text, bigint, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fsm_core.archive_event_from_fsm_type_worker_v2(text, bigint, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) TO fsm_worker;
