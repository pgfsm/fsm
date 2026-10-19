DROP FUNCTION IF EXISTS fsm_core.get_descendant_states_for_entry_v2;
DROP FUNCTION IF EXISTS fsm_core.get_ancestor_states_for_entry_v2;
DROP TYPE IF EXISTS fsm_core.descendant_states_result_v2;
DROP TYPE IF EXISTS fsm_core.ancestor_states_result_v2;


CREATE OR REPLACE FUNCTION fsm_core.get_initial_actions_v2(
    input_state_paths TEXT[],
    input_fsm_name TEXT,
    input_fsm_version TEXT
)
RETURNS JSONB AS $$
DECLARE
    all_actions JSONB := '[]'::jsonb;
    rec RECORD;
    initial_record JSONB;
    action JSONB;
    actions_array JSONB;
    i INTEGER;
BEGIN
    -- Collect all actions from matching records' initial column
    FOR rec IN
        SELECT 
            COALESCE(fs.initial, '{}'::jsonb) AS initial_data,
            fs.fsm_order,
            fs.computed_state_key_ltree
        FROM fsm_core.fsm_states fs
        WHERE 
            fs.computed_state_key_ltree = ANY(input_state_paths::ltree[])
            AND fs.fsm_name = input_fsm_name
            AND fs.fsm_version = input_fsm_version
        -- Parents before children, like get_entry_actions_v2 (#506).
        ORDER BY fs.fsm_order ASC
    LOOP
        initial_record := rec.initial_data;
        
        -- Check if initial_data is not empty and has actions
        IF initial_record IS NOT NULL AND initial_record != '{}'::jsonb THEN
            -- Extract actions array from initial structure
            actions_array := initial_record->'actions';
            
            -- Process actions if they exist and are not empty
            IF actions_array IS NOT NULL AND jsonb_array_length(actions_array) > 0 THEN
                FOR i IN 0..jsonb_array_length(actions_array)-1 LOOP
                    action := actions_array->i;
                    -- Add metadata to each action
                    action := action || jsonb_build_object(
                        'fsm_order', rec.fsm_order,
                        'action_type', 'initial'
                    );
                    all_actions := all_actions || jsonb_build_array(action);
                END LOOP;
            END IF;
        END IF;
    END LOOP;
    
    -- Return single JSON with combined actions array
    -- Actions are already sorted by fsm_order ASC due to the ORDER BY in the query
    -- RETURN jsonb_build_object('actions', all_actions);
    RETURN all_actions;
END;
$$ LANGUAGE plpgsql IMMUTABLE;


CREATE OR REPLACE FUNCTION fsm_core.get_entry_actions_v2(
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
            COALESCE(fs.entry, '[]'::jsonb) AS entry_actions,
            COALESCE(fs.invoke, '[]'::jsonb) AS invoke_actions,
            fs.fsm_order,
            fs.fsm_name,
            fs.fsm_version
        FROM fsm_core.fsm_states fs
        WHERE 
            fs.computed_state_key_ltree = ANY(input_state_paths::ltree[])
            AND fs.fsm_name = input_fsm_name
            AND fs.fsm_version = input_fsm_version
        -- Parents before children, as XState enters states (#506).
        ORDER BY fs.fsm_order ASC
    LOOP
        -- Process entry actions and add to combined array
        IF jsonb_array_length(rec.entry_actions) > 0 THEN
            FOR i IN 0..jsonb_array_length(rec.entry_actions)-1 LOOP
                action := rec.entry_actions->i;
                action := action || jsonb_build_object(
                    'fsm_order', rec.fsm_order,
                    'action_type', 'entry',
                    'parentFsmName', rec.fsm_name,
                    'parentFsmVersion', rec.fsm_version
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
                    'action_type', 'invoke',
                    'parentFsmName', rec.fsm_name,
                    'parentFsmVersion', rec.fsm_version
                );
                all_actions := all_actions || jsonb_build_array(action);
            END LOOP;
        END IF;
    END LOOP;
    
    -- Return single JSON with combined actions array
    -- Actions are already sorted by fsm_order ASC due to the ORDER BY in the query
    -- RETURN jsonb_build_object('actions', all_actions);
    RETURN all_actions;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- testing for inintal transition entry actions
-- SELECT fsm_core.get_entry_actions_v2(ARRAY[
--     'machine'
-- ], 'creditCheck', 'v3');


CREATE TYPE fsm_core.descendant_states_result_v2 AS (
    descendant_states_to_enter TEXT[],
    descendant_states_for_default_entry TEXT[]
);

CREATE OR REPLACE FUNCTION fsm_core.get_descendant_states_for_entry_v2(input_state_id TEXT, fsm_name_param TEXT, fsm_version_param TEXT)
RETURNS fsm_core.descendant_states_result_v2 AS $$
-- XState's addDescendantStatesToEnter (packages/core/src/stateUtils.ts) for one
-- state, without history:
--
--   if (stateNode.type === 'compound') {
--     const [initialState] = stateNode.initial.target;
--     statesToEnter.add(initialState);
--     statesForDefaultEntry.add(initialState);
--     addDescendantStatesToEnter(initialState, historyValue, statesForDefaultEntry, statesToEnter);
--     addProperAncestorStatesToEnter(initialState, stateNode, statesToEnter, historyValue, statesForDefaultEntry);
--   } else if (stateNode.type === 'parallel') {
--     for (const child of getChildren(stateNode).filter((sn) => !isHistoryNode(sn))) {
--       if (![...statesToEnter].some((s) => isDescendant(s, child))) {
--         statesToEnter.add(child);
--         statesForDefaultEntry.add(child);
--         addDescendantStatesToEnter(child, historyValue, statesForDefaultEntry, statesToEnter);
--       }
--     }
--   }
--
-- XState adds to the caller's sets; this returns the two lists
-- (descendant_states_to_enter = statesToEnter, descendant_states_for_default_entry
-- = statesForDefaultEntry) for the caller to merge. Differences:
--   * The parallel branch has no `some(isDescendant)` check. It sees only its
--     own lists, not the caller's statesToEnter, so it enters every region at
--     its initial state even when another target of the same transition is
--     already inside that region (only a transition with several targets can
--     do that). It does not skip history children either (#507).
--   * The initial target is looked up by id (#507).
DECLARE
    result fsm_core.descendant_states_result_v2;
    descendant_states_to_enter TEXT[] := ARRAY[]::TEXT[];
    descendant_states_for_default_entry TEXT[] := ARRAY[]::TEXT[];
    state_record fsm_core.fsm_states;
    child_states JSONB;
    child_state JSONB;
    child_id TEXT;
    sanitized_child_id TEXT;
    sanitized_child_id_ltree LTREE;
    initial_state TEXT;
    sanitized_initial_state TEXT;
    sanitized_initial_state_ltree LTREE;
    child_result fsm_core.descendant_states_result_v2;
    ancestors TEXT[];
    ancestors_result RECORD;
BEGIN
    -- Initialize result
    result.descendant_states_to_enter := ARRAY[]::TEXT[];
    result.descendant_states_for_default_entry := ARRAY[]::TEXT[];
    
    -- Get the state record from database using state_path, fsm_name, and fsm_version
    SELECT * INTO state_record
    FROM fsm_core.fsm_states 
    WHERE computed_state_key_ltree = input_state_id::LTREE 
      AND fsm_name = fsm_name_param 
      AND fsm_version = fsm_version_param;

    RAISE NOTICE 'state_record.type: %', state_record.type;
    -- If state doesn't exist, return empty arrays
    IF state_record IS NULL THEN
        RETURN result;
    END IF;
    
    -- Process based on state type
    IF state_record.type = 'compound' THEN
        -- if (stateNode.type === 'compound')
        IF state_record.initial IS NOT NULL AND state_record.initial->'target' IS NOT NULL THEN
            initial_state := state_record.initial->'target'->>0;
            RAISE NOTICE 'Initial state: %', initial_state;
            -- const [initialState] = stateNode.initial.target: an id, mapped to its key path
            sanitized_initial_state := fsm_core.sanitize_text_to_ltree(input_text := initial_state)::TEXT;
            SELECT computed_state_key_ltree INTO sanitized_initial_state_ltree
            FROM fsm_core.fsm_states
            WHERE computed_state_id_ltree = sanitized_initial_state::ltree;
            
            
            -- statesToEnter.add(initialState); statesForDefaultEntry.add(initialState);
            descendant_states_to_enter := array_append(descendant_states_to_enter, sanitized_initial_state_ltree::text);
            descendant_states_for_default_entry := array_append(descendant_states_for_default_entry, sanitized_initial_state_ltree::text);
            
            -- addDescendantStatesToEnter(initialState, historyValue, statesForDefaultEntry, statesToEnter);
            child_result := fsm_core.get_descendant_states_for_entry_v2(input_state_id := sanitized_initial_state_ltree::text, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param);

            descendant_states_to_enter := array_cat(descendant_states_to_enter, child_result.descendant_states_to_enter);
            descendant_states_for_default_entry := array_cat(descendant_states_for_default_entry, child_result.descendant_states_for_default_entry);

            -- addProperAncestorStatesToEnter(initialState, stateNode, ...):
            -- addAncestorStatesToEnter(..., getProperAncestors(initialState, stateNode)),
            -- the states between stateNode and its initial target. There are none
            -- when the initial target is a direct child, as it is in XState v5.

            ancestors := fsm_core.get_proper_ancestors(state_path_ltree := sanitized_initial_state_ltree::TEXT, to_state_path_ltree := state_record.computed_state_key_ltree::TEXT);
            ancestors_result := fsm_core.get_ancestor_states_for_entry_v2(
                ancestors := ancestors,
                reentrancy_domain := NULL,
                fsm_name_param := fsm_name_param,
                fsm_version_param := fsm_version_param
            );

            -- Only its states to enter are kept. Its default entries would come
            -- from a parallel state between stateNode and the initial target;
            -- there is none when the target is a direct child.
            descendant_states_to_enter := array_cat(descendant_states_to_enter, ancestors_result.ancestor_states_to_enter);
            

        END IF;
        
    ELSIF state_record.type = 'parallel' THEN
        -- else if (stateNode.type === 'parallel'): every child, with no
        -- some(isDescendant) check and no history filter (see above).
        child_states := state_record.states;
        
        IF child_states IS NOT NULL THEN
            FOR child_state IN SELECT value FROM jsonb_each(child_states)
            LOOP
                child_id := child_state->>'id';
                
                -- the child's id, mapped to its key path
                sanitized_child_id := fsm_core.sanitize_text_to_ltree(input_text := child_id)::TEXT;
                SELECT computed_state_key_ltree INTO sanitized_child_id_ltree
                FROM fsm_core.fsm_states
                WHERE computed_state_id_ltree = sanitized_child_id::ltree;

                -- statesToEnter.add(child); statesForDefaultEntry.add(child);
                descendant_states_to_enter := array_append(descendant_states_to_enter, sanitized_child_id_ltree::text);
                descendant_states_for_default_entry := array_append(descendant_states_for_default_entry, sanitized_child_id_ltree::text);
                
                -- addDescendantStatesToEnter(child, historyValue, statesForDefaultEntry, statesToEnter);
                child_result := fsm_core.get_descendant_states_for_entry_v2(input_state_id := sanitized_child_id_ltree::text, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param);
                descendant_states_to_enter := array_cat(descendant_states_to_enter, child_result.descendant_states_to_enter);
                descendant_states_for_default_entry := array_cat(descendant_states_for_default_entry, child_result.descendant_states_for_default_entry);
            END LOOP;
        END IF;
    ELSIF state_record.type = 'atomic' OR state_record.type = 'final' THEN
        -- Atomic and final states have no descendants.
        
    END IF;
   
    -- They are Sets in XState: remove duplicates.
    SELECT array_agg(DISTINCT state) INTO descendant_states_to_enter 
    FROM unnest(descendant_states_to_enter) AS state;
    
    SELECT array_agg(DISTINCT state) INTO descendant_states_for_default_entry 
    FROM unnest(descendant_states_for_default_entry) AS state;
    
    -- Set result values
    result.descendant_states_to_enter := COALESCE(descendant_states_to_enter, ARRAY[]::TEXT[]);
    result.descendant_states_for_default_entry := COALESCE(descendant_states_for_default_entry, ARRAY[]::TEXT[]);

    RAISE NOTICE 'fsm_core.get_descendant_states_for_entry_v2 result: %', result;
    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Example usage:
-- SELECT fsm_core.get_descendant_states_for_entry_v2('machine.creditCheck.CheckingCreditScores', 'creditCheck', 'v2');


-- Custom type to return both arrays
CREATE TYPE fsm_core.ancestor_states_result_v2 AS (
    ancestor_states_to_enter TEXT[],
    ancestor_states_for_default_entry TEXT[]
);


CREATE OR REPLACE FUNCTION fsm_core.get_ancestor_states_for_entry_v2(
    ancestors TEXT[],                -- Array of ancestor state_path (as text)
    reentrancy_domain TEXT,          -- Optional: state_path (as text), can be NULL
    fsm_name_param TEXT,
    fsm_version_param TEXT
) RETURNS fsm_core.ancestor_states_result_v2 AS $$
-- XState's addAncestorStatesToEnter (packages/core/src/stateUtils.ts), without
-- history:
--
--   for (const anc of ancestors) {
--     if (!reentrancyDomain || isDescendant(anc, reentrancyDomain)) {
--       statesToEnter.add(anc);
--     }
--     if (anc.type === 'parallel') {
--       for (const child of getChildren(anc).filter((sn) => !isHistoryNode(sn))) {
--         if (![...statesToEnter].some((s) => isDescendant(s, child))) {
--           statesToEnter.add(child);
--           addDescendantStatesToEnter(child, historyValue, statesForDefaultEntry, statesToEnter);
--         }
--       }
--     }
--   }
--
-- Returns the two lists (ancestor_states_to_enter = statesToEnter,
-- ancestor_states_for_default_entry = statesForDefaultEntry) for the caller to
-- merge. The `some(isDescendant)` check looks at this function's own list, not
-- the caller's whole statesToEnter, so a region also counts as covering itself
-- (s = child OR is_descendant(s, child)): the ancestors come nearest first, so
-- the region on the way to the target is already in the list when its parallel
-- parent is reached. A region
-- added here is not a default entry, as in XState; its initial states are
-- (addDescendantStatesToEnter). History children are not skipped, and the
-- child is looked up by id (#507).
DECLARE
    ancestor_states_to_enter TEXT[] := ARRAY[]::TEXT[];
    ancestor_states_for_default_entry TEXT[] := ARRAY[]::TEXT[];
    anc TEXT;
    anc_record fsm_core.fsm_states;
    child_state JSONB;
    child_id TEXT;
    sanitized_child_id TEXT;
    sanitized_child_id_ltree LTREE;
    child_covered BOOLEAN;
    st_path TEXT;
    child_result RECORD;
    result fsm_core.ancestor_states_result_v2;
BEGIN
    FOREACH anc IN ARRAY ancestors LOOP
        -- if (!reentrancyDomain || isDescendant(anc, reentrancyDomain)): a
        -- parallel domain added to the ancestors is not entered again (#506).
        IF fsm_core.is_descendant(input_child := anc::ltree, input_parent := reentrancy_domain::ltree) THEN
            IF NOT (anc = ANY(ancestor_states_to_enter)) THEN
                ancestor_states_to_enter := array_append(ancestor_states_to_enter, anc);
            END IF;
        END IF;

        -- if (anc.type === 'parallel')
        SELECT * INTO anc_record
        FROM fsm_core.fsm_states
        WHERE computed_state_key_ltree = anc::ltree
          AND fsm_name = fsm_name_param
          AND fsm_version = fsm_version_param
        LIMIT 1;

        IF anc_record.type = 'parallel' THEN
            -- for (const child of getChildren(anc))
            IF anc_record.states IS NOT NULL THEN
                FOR child_state IN SELECT value FROM jsonb_each(anc_record.states)
                LOOP
                    child_id := child_state->>'id';
                    -- the child's id, mapped to its key path
                    sanitized_child_id := fsm_core.sanitize_text_to_ltree(input_text := child_id)::TEXT;
                    SELECT computed_state_key_ltree INTO sanitized_child_id_ltree
                    FROM fsm_core.fsm_states
                    WHERE computed_state_id_ltree = sanitized_child_id::ltree;
                    -- if (![...statesToEnter].some((s) => isDescendant(s, child)))
                    -- The child itself counts too (s = child): this checks its own
                    -- list, where the region on the way to the target stands for the
                    -- target (see above). An empty list covers nothing: a region
                    -- targeted directly from a sibling region leaves it empty here.
                    -- FOREACH runs zero times on an empty array; the earlier
                    -- FOR i IN 1..array_length(...) failed on its NULL bound (#506).
                    --
                    -- The same check as one query:
                    --   child_covered := EXISTS (
                    --       SELECT 1 FROM unnest(ancestor_states_to_enter) AS st(path)
                    --       WHERE st.path::ltree = sanitized_child_id_ltree
                    --          OR fsm_core.is_descendant(input_child := st.path::ltree, input_parent := sanitized_child_id_ltree));
                    IF sanitized_child_id_ltree::TEXT IS NOT NULL THEN
                        child_covered := FALSE;
                        FOREACH st_path IN ARRAY COALESCE(ancestor_states_to_enter, ARRAY[]::TEXT[]) LOOP
                            IF st_path::ltree = sanitized_child_id_ltree
                               OR fsm_core.is_descendant(input_child := st_path::ltree, input_parent := sanitized_child_id_ltree) THEN
                                child_covered := TRUE;
                                EXIT;
                            END IF;
                        END LOOP;
                        IF NOT child_covered THEN
                            ancestor_states_to_enter := array_append(ancestor_states_to_enter, sanitized_child_id_ltree::text);
                           
                           
                            -- statesToEnter.add(child) (above), then
                            -- addDescendantStatesToEnter(child, historyValue, statesForDefaultEntry, statesToEnter):
                            child_result := fsm_core.get_descendant_states_for_entry_v2(input_state_id := sanitized_child_id_ltree::text, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param);
                            
                            -- its states to enter, and its default entries (statesForDefaultEntry)
                            ancestor_states_to_enter := array_cat(ancestor_states_to_enter, child_result.descendant_states_to_enter);
                            ancestor_states_for_default_entry := array_cat(ancestor_states_for_default_entry, child_result.descendant_states_for_default_entry);
                        END IF;
                    END IF;
                END LOOP;
            END IF;
        END IF;
    END LOOP;

    -- They are Sets in XState: remove duplicates.
    SELECT array_agg(DISTINCT s) INTO ancestor_states_to_enter FROM unnest(ancestor_states_to_enter) AS s;
    SELECT array_agg(DISTINCT s) INTO ancestor_states_for_default_entry FROM unnest(ancestor_states_for_default_entry) AS s;
    
    -- Prepare result
    result.ancestor_states_to_enter := COALESCE(ancestor_states_to_enter, ARRAY[]::TEXT[]);
    result.ancestor_states_for_default_entry := COALESCE(ancestor_states_for_default_entry, ARRAY[]::TEXT[]);
    
    RETURN result;
END;
$$ LANGUAGE plpgsql;


-- Renamed compute_entry_set_v2: it is XState's computeEntrySet only. The
-- actions each entered state brings are picked by enter_states_v2, as
-- XState's enterStates does (#518).
DROP FUNCTION IF EXISTS fsm_core.compute_entry_actions_v2(fsm_core.fsm_transitions, TEXT, TEXT, BOOLEAN);

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
--   for (const stateNodeToEnter of [...statesToEnter].sort((a, b) => a.order - b.order)) {
--     mutStateNodeSet.add(stateNodeToEnter);
--     actions.push(...stateNodeToEnter.entry, spawnChild per invoke,
--                  ...initial.actions if statesForDefaultEntry.has(stateNodeToEnter));
--     if (stateNodeToEnter.type === 'final') { ... }
--   }
--
-- compute_entry_set_v2 is computeEntrySet. The loop goes through the states to
-- enter as XState's does: adds each to the active states and collects its
-- actions. A final state's done.state events are not raised yet (#504). The
-- actions are returned for the sync worker to run: a state's entry actions and
-- a spawnChild per invoke in entry_actions, its initial actions in
-- initial_actions (the worker puts each after its state's entry actions,
-- orderEntryActions).
--
-- state_node_set is the active states after exitStates (exit_states_v2).
-- Returns states_to_enter, entry_actions, initial_actions and state_node_set
-- (mutStateNodeSet afterwards, sorted).
DECLARE
    entry_set JSONB;
    states_to_enter TEXT[];
    states_for_default_entry TEXT[];
    entry_actions JSONB := '[]'::jsonb;
    initial_actions JSONB := '[]'::jsonb;
    mut_state_node_set TEXT[] := COALESCE(state_node_set, ARRAY[]::TEXT[]);
    state_to_enter fsm_core.fsm_states;
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
    END LOOP;

    RETURN jsonb_build_object(
        'states_to_enter', to_jsonb(states_to_enter),
        'entry_actions', entry_actions,
        'initial_actions', initial_actions,
        'state_node_set', to_jsonb(ARRAY(
            SELECT DISTINCT x FROM unnest(mut_state_node_set || states_to_enter) AS x ORDER BY x
        ))
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


-- SELECT fsm_core.test_event_transition_for_entry_v2(
-- 'initialTransition_event', 
-- 'creditCheck', 
-- 'v3'
-- );