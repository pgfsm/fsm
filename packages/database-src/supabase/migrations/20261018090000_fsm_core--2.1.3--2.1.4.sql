set check_function_bodies = off;

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
                    -- XState v5 writes a transition's guard as `guard` (a name, or
                    -- { type, params }); `cond` is the v4 key, kept as a fallback.
                    -- Reading only `cond` dropped every guard (#510).
                    cond := COALESCE(transition->'guard', transition->'cond');

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

CREATE OR REPLACE FUNCTION fsm_core.select_all_transitions_v2(event_name text, input_state_value text[], fsm_name_param text, fsm_version_param text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
	transitions JSONB;
BEGIN
	transitions := (
		-- In definition order: the loader inserts a state's transitions in
		-- document order, and selection takes the first whose guard passes
		-- (XState's StateNode.next, #510).
		SELECT jsonb_agg(t ORDER BY t.id)
		FROM (
			SELECT * FROM fsm_core.fsm_transitions
			WHERE event_type = event_name
			  AND computed_sanitized_source_ltree::text = ANY(input_state_value)
			  AND fsm_name = fsm_name_param
			  AND fsm_version = fsm_version_param
		) t
	);
	IF transitions IS NULL THEN
		transitions := '[]'::jsonb;
	END IF;
	RETURN transitions;
END;
$function$;
