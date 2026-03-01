set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.load_fsm_state_from_json_v1(json_input jsonb, root_node_text text, input_fsm_name text, input_fsm_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    state_key TEXT;
    state_key_ltree LTREE;
    state_id TEXT;
    state_id_ltree LTREE;
    state_obj JSONB;
    root_key TEXT;
    prefix TEXT := input_fsm_name || '.' || input_fsm_version;
    total_calls INTEGER := 0; -- aggregate count of calls including recursion
    child_result JSONB;
    child_calls INTEGER;
    child_ok BOOLEAN;
BEGIN
    total_calls := 1; -- this invocation

    state_id_ltree := fsm_core.sanitize_text_to_ltree(json_input->>'id');
    state_key_ltree := fsm_core.sanitize_text_to_ltree(json_input->>'key');

    IF root_node_text IS NOT NULL THEN
        root_key := root_node_text || '.' || state_key_ltree::TEXT;
    ELSE
        root_key := state_key_ltree::TEXT;
    END IF;

    RAISE NOTICE 'Inserting state with root_key: %', root_key;

    -- 1. Insert root state with all columns
    INSERT INTO fsm_core.fsm_states (
        state_id_with_fsm_name_and_fsm_version, computed_state_id_ltree, computed_state_key_ltree, id, key, parent_node, type, description, fsm_order, context, states, initial, fsm_on, transitions, entry, exit, invoke, data, history, fsm_version, fsm_name
    ) VALUES (
        -- TODO: state_id_with_fsm_name_and_fsm_version can be combined with prefix.  root_key OR state_id_ltree
        -- (prefix || '.' || root_key)::ltree,
        prefix || '.' || state_id_ltree::TEXT,
        (state_id_ltree)::ltree,
        (root_key)::ltree,
        json_input->>'id',
        json_input->>'key',
        root_node_text, -- parent_node
        (json_input->>'type')::fsm_core.fsm_state_type,
        json_input->>'description',
        (json_input->>'order')::INTEGER,
        json_input->'context',
        json_input->'states',
        json_input->'initial',
        json_input->'on',
        json_input->'transitions',
        json_input->'entry',
        json_input->'exit',
        json_input->'invoke',
        json_input->'data',
        json_input->>'history',
        input_fsm_version,
        input_fsm_name
    )
    ON CONFLICT DO NOTHING;

    RAISE NOTICE 'invoke value: %', json_input->'invoke';

    -- 2. check for all invokes (assume invoke is always an array)
    IF json_input::jsonb ? 'invoke' THEN
        DECLARE
            inv_item JSONB;
            child_count INTEGER;
        BEGIN
            FOR inv_item IN SELECT value FROM jsonb_array_elements(json_input->'invoke')
            LOOP
                RAISE NOTICE 'Processing invoke item: %', inv_item;

                IF inv_item IS NOT NULL AND inv_item->>'fsmType' = 'fsm' THEN
                    RAISE NOTICE 'Found fsm invoke: %', inv_item;
                    -- Check if src (child FSM name) and fsmVersion exists
                    IF (inv_item->>'src') IS NOT NULL AND (inv_item->>'fsmVersion') IS NOT NULL THEN

                        SELECT COUNT(*) INTO child_count
                        FROM fsm_core.fsm_states
                        WHERE fsm_name = inv_item->>'src'
                        AND fsm_version = inv_item->>'fsmVersion';

                        IF child_count = 0 THEN -- NOT FOUND
                            RAISE EXCEPTION 'Child FSM not found in fsm_core.fsm_states: %, %', inv_item->>'src', inv_item->>'fsmVersion';
                        ELSE
                            RAISE NOTICE 'Child FSM found in fsm_core.fsm_states: %, % (count=%)', inv_item->>'src', inv_item->>'fsmVersion', child_count;
                        END IF;
                    ELSE
                        RAISE WARNING 'Missing src or fsmVersion in invoke item: %', inv_item;
                    END IF;
                END IF;

            END LOOP;
        END;
    ELSE
        RAISE NOTICE 'No invoke property present';
    END IF;

    -- 3. Insert all nested states with all columns and their transitions
    FOR state_key, state_obj IN
        SELECT key, value
        FROM jsonb_each(json_input->'states')
    LOOP
        -- Only call recursively if state_obj is not null
        IF state_obj IS NOT NULL THEN
            RAISE NOTICE 'Inserting nested state key: % and root_key: %', state_obj->>'id', root_key;
            -- Call recursively and capture result to aggregate counts and propagate errors
            child_result := fsm_core.load_fsm_state_from_json_v1(state_obj, root_key, input_fsm_name, input_fsm_version);
            -- If child_result is null (should not happen), raise an exception
            IF child_result IS NULL THEN
                RAISE EXCEPTION 'Child loader returned NULL for nested state % under %', state_obj->>'id', root_key;
            END IF;

            -- Extract child's calls and ok
            child_ok := COALESCE((child_result->>'ok')::BOOLEAN, false);
            child_calls := COALESCE((child_result->>'fsm_core.fsm_states_count')::INTEGER, 0);
            total_calls := total_calls + child_calls;

            IF NOT child_ok THEN
                -- Re-raise child error as an exception to propagate upward
                RAISE EXCEPTION 'Child loader error for nested state % under %: %', state_obj->>'id', root_key, COALESCE(child_result->>'error', child_result::TEXT);
            END IF;
        ELSE
            RAISE NOTICE 'Skipping state due to missing required fields: %', state_obj;
        END IF;
    END LOOP;

    -- Success: return ok true and count
    RETURN jsonb_build_object('ok', to_jsonb(true), 'fsm_core.fsm_states_count', to_jsonb(total_calls));

END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.load_fsm_transition_from_json_v1(json_input jsonb, root_node_text text, fsm_name text, fsm_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
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
    state_id_ltree := fsm_core.sanitize_text_to_ltree(json_input->>'id');
    state_key_ltree := fsm_core.sanitize_text_to_ltree(json_input->>'key');

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
                    sanitized_source := fsm_core.sanitize_text_to_ltree(source);

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
                        sanitized_target_array := fsm_core.sanitize_text_array_to_ltree_array(target_array);
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
    
                   -- Use already sanitized target array in transition_domain_lca in v2

                    INSERT INTO fsm_core.fsm_transitions (
                        source, computed_sanitized_source_ltree, target, computed_sanitized_target_ltree_array, event_type, actions, cond, computed_transition_domain_lca,
                                            reenter, fsm_name, fsm_version
                    )
                                    VALUES (source, sanitized_source_ltree, target_array, sanitized_target_ltree_array, event_type, actions, cond, null, reenter, fsm_name, fsm_version);
                
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
            child_result := fsm_core.load_fsm_transition_from_json_v1(state_obj, root_key, fsm_name, fsm_version);
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
$function$
;


