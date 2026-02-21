set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.load_fsm_from_json(json_input json, root_node_text text, fsm_name text, fsm_version text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
    state_key TEXT;
    state_key_ltree LTREE;
    state_obj JSON;
    state_id TEXT;
    state_id_ltree LTREE;
    transition JSON;
    transition_array JSON[];
    source TEXT;
    sanitized_source_ltree LTREE;
    target_array TEXT[];
    sanitized_target_ltree_array LTREE[];
    event_type TEXT;
    actions JSON;
    cond JSON;
    reenter BOOLEAN;
    transition_domain_lca ltree;
    root_key TEXT;
    prefix TEXT := fsm_name || '.' || fsm_version;
BEGIN
    
    state_id_ltree := sanitize_to_ltree(json_input->>'id');
    state_key_ltree := sanitize_to_ltree(json_input->>'key');

    IF root_node_text IS NOT NULL THEN
        
        root_key := root_node_text || '.' || state_key_ltree::TEXT;
    ELSE
        
        root_key := state_key_ltree::TEXT;
    END IF;


    RAISE NOTICE 'Inserting state with root_key: %', root_key;

    -- 1. Insert root state with all columns
    INSERT INTO fsm_states (
        state_id_with_fsm_name_and_fsm_version, computed_state_id_ltree, computed_state_key_ltree, id, key, type, description, fsm_order, context, states, initial, fsm_on, transitions, entry, exit, invoke, data, history, fsm_version, fsm_name
    ) VALUES (
        -- TODO: state_id_with_fsm_name_and_fsm_version can be combined with prefix.  root_key OR state_id_ltree
        -- (prefix || '.' || root_key)::ltree,
        prefix || '.' || state_id_ltree::TEXT,
        (state_id_ltree)::ltree,
        (root_key)::ltree,
        json_input->>'id',
        json_input->>'key',
        (json_input->>'type')::fsm_state_type,
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
        fsm_version,
        fsm_name
    )
    ON CONFLICT DO NOTHING;

    -- 2. Top-level transitions
    IF json_input::jsonb ? 'transitions' THEN
        SELECT ARRAY_AGG(value) INTO transition_array
        FROM json_array_elements(json_input->'transitions');

        IF transition_array IS NOT NULL THEN
            FOREACH transition IN ARRAY transition_array
                LOOP
                    -- Clean source
                    source := transition->>'source';
                    sanitized_source_ltree := sanitize_to_ltree(source);
                    event_type := transition->>'eventType';

                    SELECT ARRAY(
                            SELECT json_array_elements_text(transition->'target')
                    ) INTO target_array;

                    RAISE NOTICE 'target_array: %', target_array;
                    -- Sanitize target array
                    IF target_array IS NULL THEN
                        sanitized_target_ltree_array := ARRAY[]::ltree[];
                    ELSE
                        sanitized_target_ltree_array := sanitize_text_array_to_ltree_array(target_array);
                    END IF;

                    RAISE NOTICE 'sanitized_target_array: %', sanitized_target_ltree_array;


                    -- Get actions and cond
                    actions := transition->'actions';
                    cond := transition->'cond';

                    -- Get reenter flag (may be null)
                    IF (transition::jsonb ? 'reenter') THEN
                        reenter := (transition->>'reenter')::boolean;
                    ELSE
                        reenter := NULL;
                    END IF;
    
                    

                    INSERT INTO fsm_transitions (
                        source, computed_sanitized_source_ltree, target, computed_sanitized_target_ltree_array, event_type, actions, cond, 
                                            reenter, fsm_name, fsm_version
                    )
                                    VALUES (source, sanitized_source_ltree, target_array, sanitized_target_ltree_array, event_type, actions, cond, reenter, fsm_name, fsm_version);
                
                    RAISE NOTICE 'Inserted top-level transition: source=%, target=%, event_type=%', source, target_array, event_type;  

            END LOOP;
        END IF;
    END IF;

    -- 3. Insert all nested states with all columns and their transitions
    FOR state_key, state_obj IN
        SELECT key, value
        FROM json_each(json_input->'states')
    LOOP
        -- Only call recursively if state_obj is not null and has required fields
        -- IF state_obj IS NOT NULL AND state_obj->>'id' IS NOT NULL AND state_obj->>'key' IS NOT NULL AND state_obj->>'type' IS NOT NULL THEN
        IF state_obj IS NOT NULL THEN
            BEGIN
                RAISE NOTICE 'Inserting nested state key: % and root_key: %', state_obj->>'id', root_key;
                PERFORM load_fsm_from_json(state_obj, root_key, fsm_name, fsm_version);
            EXCEPTION WHEN OTHERS THEN
                RAISE NOTICE 'Error in recursive load_fsm_from_json: %, state_obj: %', SQLERRM, state_obj;
            END;
        ELSE
            RAISE NOTICE 'Skipping state due to missing required fields: %', state_obj;
        END IF;
    END LOOP;

END;
$function$
;


