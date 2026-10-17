set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.is_descendant(
    input_child ltree,
    input_parent ltree
) RETURNS boolean AS $$
    SELECT input_parent IS NULL
        OR (input_child <@ input_parent AND input_child <> input_parent);
$$ LANGUAGE sql IMMUTABLE;

-- Called only from fsm_core functions; not executable by PUBLIC (access
-- control, SPEC-009 §1).
REVOKE EXECUTE ON FUNCTION fsm_core.is_descendant(ltree, ltree) FROM PUBLIC;

CREATE OR REPLACE FUNCTION fsm_core.find_least_common_ancestor_v2(
    input_paths ltree[],
    input_fsm_name text,
    input_fsm_version text
) RETURNS ltree AS $$
    -- Where ltree's lca() would do: it already returns a proper ancestor
    -- (lca('r.c.x', 'r.c') = 'r', never one of its inputs), so with the root's
    -- key path as an extra input (input_root) this needs no table:
    --
    --   SELECT CASE WHEN lca(input_paths) <@ input_root THEN lca(input_paths) END;
    --
    -- That form is only for a pure function (IMMUTABLE, not reading
    -- fsm_core.fsm_states): it takes the root path as an input instead of
    -- looking anything up.
    -- `<@ input_root` rejects a result above the root ('' or 'com.acme' for
    -- the root "com.acme.m"). Or, without the root input, keep lca() only
    -- when it is a state, which rejects those same results:
    --
    --   SELECT fs.computed_state_key_ltree
    --   FROM fsm_core.fsm_states fs
    --   WHERE fs.fsm_name = input_fsm_name
    --     AND fs.fsm_version = input_fsm_version
    --     AND fs.computed_state_key_ltree = lca(input_paths);
    --
    -- Both are only right while no state key has a dot: lca('k.p.s3.1',
    -- 'k.p.s3.2') = 'k.p.s3', which is no state (their parent is k.p). The
    -- first returns that non-state; the second returns NULL, so the domain
    -- falls back to the root, too high. Searching the states below gives k.p.
    SELECT fs.computed_state_key_ltree
    FROM fsm_core.fsm_states fs
    WHERE fs.fsm_name = input_fsm_name
      AND fs.fsm_version = input_fsm_version
      AND fs.computed_state_key_ltree @> ALL (input_paths)       -- contains every path
      AND NOT (fs.computed_state_key_ltree = ANY (input_paths))  -- but is none of them
    ORDER BY nlevel(fs.computed_state_key_ltree) DESC            -- the deepest one
    LIMIT 1;
$$ LANGUAGE sql STABLE;

-- Called only from fsm_core functions; not executable by PUBLIC (access
-- control, SPEC-009 §1).
REVOKE EXECUTE ON FUNCTION fsm_core.find_least_common_ancestor_v2(ltree[], text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION fsm_core.get_transition_domain_v2(
    input_source ltree,
    input_targets ltree[],
    input_reenter boolean,
    input_fsm_name text,
    input_fsm_version text
) RETURNS ltree AS $$
DECLARE
    targets ltree[] := COALESCE(input_targets, ARRAY[]::ltree[]);
    domain_path ltree;
BEGIN
    -- if (!transition.reenter && targetStates.every((target) =>
    --     target === transition.source || isDescendant(target, transition.source)))
    --   return transition.source;
    IF NOT COALESCE(input_reenter, false) AND NOT EXISTS (
        SELECT 1 FROM unnest(targets) AS t(p)
        WHERE NOT (t.p = input_source
                   OR fsm_core.is_descendant(input_child := t.p, input_parent := input_source))
    ) THEN
        RETURN input_source;
    END IF;

    -- const lca = findLeastCommonAncestor(targetStates.concat(transition.source));
    -- if (lca) return lca;
    domain_path := fsm_core.find_least_common_ancestor_v2(
        input_paths := targets || input_source,
        input_fsm_name := input_fsm_name,
        input_fsm_version := input_fsm_version
    );
    IF domain_path IS NOT NULL THEN
        RETURN domain_path;
    END IF;

    -- No proper ancestor: the source or a target is the root.
    -- if (transition.reenter) return;   (no domain)
    IF COALESCE(input_reenter, false) THEN
        RETURN NULL;
    END IF;

    -- return transition.source.machine.root;
    SELECT fs.computed_state_key_ltree INTO domain_path
    FROM fsm_core.fsm_states fs
    WHERE fs.fsm_name = input_fsm_name
      AND fs.fsm_version = input_fsm_version
      AND fs.parent_node IS NULL;
    RETURN domain_path;
END;
$$ LANGUAGE plpgsql STABLE;

-- Called only from fsm_core functions; not executable by PUBLIC (access
-- control, SPEC-009 §1).
REVOKE EXECUTE ON FUNCTION fsm_core.get_transition_domain_v2(ltree, ltree[], boolean, text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION fsm_core.compute_full_exit_set_v2(transition_record fsm_core.fsm_transitions, state_node_set text[])
 RETURNS text[]
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
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
$function$;

-- Inlined into compute_full_exit_set_v2, its only caller (#506).
DROP FUNCTION IF EXISTS fsm_core.compute_child_exit_set_v2(ltree, ltree[]);

CREATE OR REPLACE FUNCTION fsm_core.compute_exit_actions_v2(transition_record fsm_core.fsm_transitions, input_state_node_set text[], input_fsm_name text, input_fsm_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
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
-- Returns exit_nodes (statesToExit; microstep_v2 removes them from the active
-- states) and exit_actions in that order. History states are not supported, so
-- nothing is recorded for them.
DECLARE
  exit_set_result TEXT[];
  actions_result JSONB;
BEGIN

  
  -- No transition: nothing exits.
  IF transition_record IS NULL THEN
      RETURN jsonb_build_object(
              'exit_nodes', '[]'::JSONB,
              'exit_actions', '[]'::JSONB
            );
  END IF;



  RAISE NOTICE 'Transition Record: %', transition_record;
  -- const statesToExit = computeExitSet(transitions, mutStateNodeSet, historyValue);
  SELECT fsm_core.compute_full_exit_set_v2(transition_record := transition_record, state_node_set := input_state_node_set) INTO exit_set_result;

  RAISE NOTICE 'Exit Set Result: %', exit_set_result;

  -- statesToExit.sort((a, b) => b.order - a.order), then per state its exit
  -- actions and a stopChild per invoke: get_exit_actions_v2 returns them in
  -- that order (fsm_order DESC, exit before invoke).
  SELECT fsm_core.get_exit_actions_v2(input_state_paths := exit_set_result, input_fsm_name := input_fsm_name, input_fsm_version := input_fsm_version) INTO actions_result;

  RAISE NOTICE 'exit_actions Result: %', actions_result;

  -- exit_nodes: what microstep_v2 removes (mutStateNodeSet.delete(s)).
  RETURN jsonb_build_object(
    'exit_nodes', exit_set_result,
    'exit_actions', actions_result->'actions'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION fsm_core.get_initial_actions_v2(input_state_paths text[], input_fsm_name text, input_fsm_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION fsm_core.get_entry_actions_v2(input_state_paths text[], input_fsm_name text, input_fsm_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION fsm_core.get_descendant_states_for_entry_v2(input_state_id text, fsm_name_param text, fsm_version_param text)
 RETURNS fsm_core.descendant_states_result_v2
 LANGUAGE plpgsql
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION fsm_core.get_ancestor_states_for_entry_v2(ancestors text[], reentrancy_domain text, fsm_name_param text, fsm_version_param text)
 RETURNS fsm_core.ancestor_states_result_v2
 LANGUAGE plpgsql
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION fsm_core.compute_entry_actions_v2(transition_record fsm_core.fsm_transitions, fsm_name_param text, fsm_version_param text, is_initial_transition boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
-- XState's computeEntrySet, plus the part of enterStates that picks the
-- actions (packages/core/src/stateUtils.ts), for one transition:
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
--   // enterStates, for each state to enter, parents first: its entry actions,
--   // a spawnChild per invoke, then initial.actions if
--   // statesForDefaultEntry.has(stateNodeToEnter).
--
-- Returned as lists: states_to_enter (statesToEnter), states_for_default_entry
-- (statesForDefaultEntry), common_states (the states to enter that are default
-- entries), their entry and invoke actions, and the common states' initial
-- actions. The sync worker runs the actions in enterStates' order
-- (orderEntryActions). The domain is the stored computed_transition_domain_lca
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
    common_states TEXT[] := '{}';
    state_to_check TEXT;
    entry_actions_result JSONB;
    initial_actions_for_common_states_result JSONB;
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

          SELECT fsm_core.get_entry_actions_v2(input_state_paths := states_to_enter, input_fsm_name := fsm_name_param, input_fsm_version := fsm_version_param) INTO entry_actions_result;
          -- Every state entered is a default entry, so each one's initial
          -- actions run; the sync worker runs them after that state's entry
          -- actions (#506).
          SELECT fsm_core.get_initial_actions_v2(input_state_paths := states_to_enter, input_fsm_name := fsm_name_param, input_fsm_version := fsm_version_param) INTO initial_actions_for_common_states_result;
          RETURN jsonb_build_object(
                'states_to_enter', states_to_enter,
                -- Every target is a default entry (computeEntrySet), and
                -- enterStates adds the root too:
                --   if (isInitial) statesForDefaultEntry.add(machine.root)
                -- The root is in states_to_enter already, so that line needs
                -- nothing extra here.
                'states_for_default_entry', states_to_enter,
                'common_states', states_to_enter,
                'entry_actions_for_states_to_enter', COALESCE(entry_actions_result, '[]'::jsonb),
                'initial_actions_for_common_states', COALESCE(initial_actions_for_common_states_result, '[]'::jsonb)
          );
    END IF;
    
    -- No transition: nothing is entered.
    IF transition_record IS NULL THEN
        RETURN jsonb_build_object(
            'states_to_enter', '[]'::jsonb,
            'states_for_default_entry', '[]'::jsonb,
            'common_states', '[]'::jsonb,
            'entry_actions_for_states_to_enter', '[]'::jsonb,
            'initial_actions_for_common_states', '[]'::jsonb
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
  
    
    -- common_states: the states to enter that statesForDefaultEntry has, i.e.
    -- the ones whose initial.actions run (enterStates).
    FOR state_to_check IN SELECT unnest(states_to_enter)
    LOOP
        -- statesForDefaultEntry.has(stateNodeToEnter)
        IF state_to_check = ANY(states_for_default_entry) THEN
            common_states := array_append(common_states, state_to_check);
        END IF;
    END LOOP;
    
    RAISE NOTICE 'Common states found: %', common_states;
        
        
  

    -- enterStates: for each state to enter, parents first, actions.push(...entry)
    -- and a spawnChild per invoke: get_entry_actions_v2 (fsm_order ASC).
    SELECT fsm_core.get_entry_actions_v2(input_state_paths := states_to_enter, input_fsm_name := fsm_name_param, input_fsm_version := fsm_version_param) INTO entry_actions_result;

    -- Initial actions of the states entered by default (XState's
    -- statesForDefaultEntry). Returned on their own: the sync worker runs each
    -- one after its state's entry actions, as XState's enterStates does (#506).
    IF array_length(common_states, 1) > 0 THEN
        SELECT fsm_core.get_initial_actions_v2(input_state_paths := common_states, input_fsm_name := fsm_name_param, input_fsm_version := fsm_version_param) INTO initial_actions_for_common_states_result;
    END IF;


    -- Build the final result containing both arrays and their respective actions
    -- Empty arrays, not JSON null, when nothing is entered (a targetless
    -- transition): microstep_v2 expands states_to_enter (#506).
    final_result := jsonb_build_object(
        'states_to_enter', COALESCE(to_jsonb(states_to_enter), '[]'::jsonb),
        'states_for_default_entry', COALESCE(to_jsonb(states_for_default_entry), '[]'::jsonb),
        'common_states', COALESCE(to_jsonb(common_states), '[]'::jsonb),
        'entry_actions_for_states_to_enter', COALESCE(entry_actions_result, '[]'::jsonb),
        'initial_actions_for_common_states', COALESCE(initial_actions_for_common_states_result, '[]'::jsonb)
    );

    RETURN final_result;
END;
$function$;

CREATE OR REPLACE FUNCTION fsm_core.load_fsm_transition_from_json_v2(json_input jsonb, root_node_text text, fsm_name text, fsm_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    state_key TEXT;
    state_key_ltree LTREE;
    state_id TEXT;
    state_id_ltree LTREE;
    state_obj JSONB;
    transition JSONB;
    transition_array JSONB[];
    source TEXT;
    sanitized_source LTREE;
    sanitized_source_ltree LTREE;
    target_array TEXT[];
    sanitized_target_array LTREE[];
    sanitized_target_ltree_array LTREE[];
    event_type TEXT;
    actions JSONB;
    cond JSONB;
    reenter BOOLEAN;
    transition_domain_lca ltree;
    root_key TEXT;
    prefix TEXT := fsm_name || '.' || fsm_version;
    total_calls INTEGER := 0;
    child_result JSONB;
    child_calls INTEGER;
    child_ok BOOLEAN;
BEGIN
    
    total_calls := 1; -- this invocation
    state_id_ltree := fsm_core.sanitize_text_to_ltree(input_text := json_input->>'id');
    state_key_ltree := fsm_core.sanitize_text_to_ltree(input_text := json_input->>'key');

    IF root_node_text IS NOT NULL THEN
        root_key := root_node_text || '.' || state_key_ltree::TEXT;
    ELSE
        root_key := state_key_ltree::TEXT;
    END IF;


    RAISE NOTICE 'Inserting state with root_key: %', root_key;


    -- 1. Top-level transitions
    IF json_input::jsonb ? 'transitions' THEN
        SELECT ARRAY_AGG(value) INTO transition_array
        FROM jsonb_array_elements(json_input->'transitions');

        IF transition_array IS NOT NULL THEN
            FOREACH transition IN ARRAY transition_array
                LOOP
                    -- Clean source
                    source := transition->>'source';
                    -- TODO:TBD:: fsm_core.sanitize_text_to_ltree or remove_hashtag_from_text
                    RAISE NOTICE 'sanitized source by using fsm_core.sanitize_text_to_ltree or remove_hashtag_from_text';
                    sanitized_source := fsm_core.sanitize_text_to_ltree(input_text := source);

                    SELECT computed_state_key_ltree INTO sanitized_source_ltree
                    FROM fsm_core.fsm_states
                    WHERE computed_state_id_ltree = sanitized_source;
                    RAISE NOTICE 'sanitized_source_ltree: %', sanitized_source_ltree;

                    SELECT ARRAY(
                            SELECT jsonb_array_elements_text(transition->'target')
                    ) INTO target_array;

                    RAISE NOTICE 'target_array: %', target_array;
                    -- Sanitize target array
                    IF target_array IS NULL THEN
                        sanitized_target_array := ARRAY[]::ltree[];
                    ELSE
                        sanitized_target_array := fsm_core.sanitize_text_array_to_ltree_array(input_array := target_array);
                    END IF;


                    SELECT ARRAY(
                            SELECT computed_state_key_ltree
                            FROM fsm_core.fsm_states
                            WHERE computed_state_id_ltree = ANY(sanitized_target_array)
                    ) INTO sanitized_target_ltree_array;

                    RAISE NOTICE 'sanitized_target_array: %', sanitized_target_ltree_array;

                    event_type := transition->>'eventType';
                    -- Get actions and cond
                    actions := transition->'actions';
                    cond := transition->'cond';

                    -- Get reenter flag (may be null)
                    IF (transition::jsonb ? 'reenter') THEN
                        reenter := (transition->>'reenter')::boolean;
                    ELSE
                        reenter := NULL;
                    END IF;
    
                    -- XState's transition domain, stored once here and read by exit
                    -- and entry. The longest common prefix of the source and targets
                    -- (sql_lca_from_array) is not it when a target is the source or
                    -- an ancestor of it, or the transition re-enters (#506).
                    transition_domain_lca := fsm_core.get_transition_domain_v2(
                        input_source := sanitized_source_ltree,
                        input_targets := sanitized_target_ltree_array,
                        input_reenter := reenter,
                        input_fsm_name := fsm_name,
                        input_fsm_version := fsm_version
                    );
                    RAISE NOTICE 'transition_domain_lca: %', transition_domain_lca;

                    INSERT INTO fsm_core.fsm_transitions (
                        source, computed_sanitized_source_ltree, target, computed_sanitized_target_ltree_array, event_type, actions, cond, computed_transition_domain_lca,
                                            reenter, fsm_name, fsm_version
                    )
                                    VALUES (source, sanitized_source_ltree, target_array, sanitized_target_ltree_array, event_type, actions, cond, transition_domain_lca, reenter, fsm_name, fsm_version);
                
                    RAISE NOTICE 'Inserted top-level transition: source=%, target=%, event_type=%', source, target_array, event_type;  
                
            END LOOP;
        END IF;
    END IF;

    -- 3. Insert all nested states with all columns and their transitions
    FOR state_key, state_obj IN
        SELECT key, value
        FROM jsonb_each(json_input->'states')
    LOOP
        -- Only call recursively if state_obj is not null and has required fields
        -- IF state_obj IS NOT NULL AND state_obj->>'id' IS NOT NULL AND state_obj->>'key' IS NOT NULL AND state_obj->>'type' IS NOT NULL THEN
        IF state_obj IS NOT NULL THEN
            RAISE NOTICE 'Inserting nested state key: % and root_key: %', state_obj->>'id', root_key;
            -- Call recursively and capture result to aggregate counts and propagate errors
            child_result := fsm_core.load_fsm_transition_from_json_v2(json_input := state_obj, root_node_text := root_key, fsm_name := fsm_name, fsm_version := fsm_version);
            IF child_result IS NULL THEN
                RAISE EXCEPTION 'Child transition loader returned NULL for nested state % under %', state_obj->>'id', root_key;
            END IF;

            child_ok := COALESCE((child_result->>'ok')::BOOLEAN, false);
            child_calls := COALESCE((child_result->>'fsm_core.fsm_transitions_count')::INTEGER, 0);
            total_calls := total_calls + child_calls;

            IF NOT child_ok THEN
                RAISE EXCEPTION 'Child transition loader error for nested state % under %: %', state_obj->>'id', root_key, COALESCE(child_result->>'error', child_result::TEXT);
            END IF;
        ELSE
            RAISE NOTICE 'Skipping state due to missing required fields: %', state_obj;
        END IF;
    END LOOP;

    -- Success: return ok true and count
    RETURN jsonb_build_object('ok', to_jsonb(true), 'fsm_core.fsm_transitions_count', to_jsonb(total_calls));

END;
$function$;

CREATE OR REPLACE FUNCTION fsm_core.microstep_v2(transition_record fsm_core.fsm_transitions, event_name text, state_value_node_set text[], fsm_name_param text, fsm_version_param text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
-- XState's microstep (packages/core/src/stateUtils.ts) for one transition:
--
--   const filteredTransitions = removeConflictingTransitions(transitions, ...);
--   if (!isInitial) [nextState, historyValue] = exitStates(...);       // 1
--   nextState = resolveActionsAndContext(..., filteredTransitions.flatMap((t) => t.actions));  // 2
--   nextState = enterStates(..., isInitial);                            // 3
--   // mutStateNodeSet: exitStates deletes each exited state, enterStates
--   // adds each entered one                                            // 4
--   if (nextState.status === 'done') ... the remaining states' exit actions
--
-- Only one transition is passed (no conflicts to remove), and the actions are
-- returned for the sync worker to run in that order instead of being run here.
-- `done` covers a top-level final state (5); done.state events and the exit
-- actions on completion are not done yet (#504).
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
	is_done BOOLEAN;
	is_initial BOOLEAN;
BEGIN
	RAISE NOTICE 'fsm_core.microstep_v2 called with event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;
	
	RAISE NOTICE 'state_value_node_set: %', state_value_node_set;


	-- The initial step enters the machine's initial states and exits nothing,
	-- whatever transition record it is given (#506).
	is_initial := event_name = 'initialTransition_event';

	-- 1. Exit states
	-- if (!isInitial) exitStates(...)
	IF is_initial THEN
		exit_result := jsonb_build_object('exit_nodes', '[]'::jsonb, 'exit_actions', '[]'::jsonb);
	ELSE
		exit_result := fsm_core.compute_exit_actions_v2(transition_record := transition_record, input_state_node_set := state_value_node_set, input_fsm_name := transition_record.fsm_name, input_fsm_version := transition_record.fsm_version);
	END IF;
	RAISE NOTICE 'exit_result: %', exit_result;
	SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[]) INTO exit_nodes
	FROM jsonb_array_elements_text(COALESCE(exit_result->'exit_nodes', '[]'::jsonb));
	RAISE NOTICE 'exit_nodes: %', exit_nodes;


	-- 2. Execute transition content:
	-- resolveActionsAndContext(..., filteredTransitions.flatMap((t) => t.actions))
	transition_actions := transition_record.actions;
	RAISE NOTICE 'transition_actions: %', transition_actions; 

	-- 3. Enter states: enterStates(..., isInitial)
	entry_result := fsm_core.compute_entry_actions_v2(transition_record := transition_record, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param, is_initial_transition := is_initial);
	RAISE NOTICE 'entry_result: %', entry_result;
	SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[]) INTO entry_nodes
	FROM jsonb_array_elements_text(COALESCE(entry_result->'states_to_enter', '[]'::jsonb));
	RAISE NOTICE 'entry_nodes: %', entry_nodes;
	

	-- 4. mutStateNodeSet: exitStates deletes each exited state and enterStates
	--    adds each entered one: (state_value_node_set - exit_nodes) + entry_nodes
	updated_state_nodes := ARRAY(
		SELECT DISTINCT x FROM (
			SELECT unnest(state_value_node_set) AS x
			EXCEPT
			SELECT unnest(exit_nodes) AS x
			UNION
			SELECT unnest(entry_nodes) AS x
		) t
		ORDER BY x
	);
	RAISE NOTICE 'updated_state_nodes: %', updated_state_nodes;

	
	updated_state_nodes_jsonb := fsm_core.build_nested_json_recursive(paths := updated_state_nodes);
	RAISE NOTICE 'updated_state_nodes_jsonb: %', updated_state_nodes_jsonb;

	-- 5. done: the machine is now in a top-level final state (a final child
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

	-- 6. Return result as JSONB
	result_json := jsonb_build_object(
		'updated_state_value_node_set', updated_state_nodes,
		'updated_state_value', updated_state_nodes_jsonb,
		'exit_actions', exit_result->'exit_actions',
		'entry_actions', entry_result->'entry_actions_for_states_to_enter',
		'initial_actions', entry_result->'initial_actions_for_common_states',
		'transition_actions', transition_actions,
		'done', is_done
	);
	RAISE NOTICE 'fsm_core.microstep_v2 result: %', result_json;
	RETURN result_json;
END;
$function$;
