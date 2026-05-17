-- this function returns all initial state nodes reachable from the given state node,
-- including handling nested compound and parallel states
CREATE OR REPLACE FUNCTION fsm_core.fsm_get_initial_state_nodes_v2(
    p_fsm_name text,
    p_fsm_version text,
    p_state_path ltree
)
RETURNS text[] LANGUAGE plpgsql AS
$$
DECLARE
    results text[];
BEGIN
    WITH RECURSIVE traverse(node_path) AS (
        -- Base case
        SELECT p_state_path

        UNION ALL

        -- Recursive step: handle compound and parallel in one recursive query
        SELECT
            CASE
                WHEN s.type = 'compound'
                     AND s.initial->'target'->>0 IS NOT NULL
                THEN fsm_core.sanitize_text_to_ltree(input_text := s.initial->'target'->>0)::ltree

                WHEN s.type = 'parallel'
                     AND s.states IS NOT NULL
                THEN (t.node_path::text || '.' || fsm_core.sanitize_text_to_ltree(input_text := c.value->>'key')::text)::ltree

                ELSE NULL
            END AS next_path
        FROM traverse t
        JOIN fsm_core.fsm_states s
          ON s.computed_state_key_ltree = t.node_path
         AND s.fsm_name = p_fsm_name
         AND s.fsm_version = p_fsm_version
        LEFT JOIN LATERAL jsonb_each(s.states) c
          ON s.type = 'parallel'
        WHERE (s.type = 'compound' AND s.initial->'target'->>0 IS NOT NULL)
           OR (s.type = 'parallel' AND s.states IS NOT NULL)
    )
    SELECT array_agg(DISTINCT node_path::text)
    INTO results
    FROM traverse
    WHERE node_path IS NOT NULL;

    RETURN results;
END;
$$;

-- SELECT fsm_core.fsm_get_initial_state_nodes_v2('creditCheck', 'v2', 'machine.creditCheck');

-- SELECT fsm_core.fsm_get_initial_state_nodes_v2('creditCheck', 'v2', 'machine.creditCheck.CheckingCreditScores');

-- SELECT fsm_core.fsm_get_initial_state_nodes_v2('creditCheck', 'v2', 'machine.creditCheck.CheckingCreditScores.CheckingGavperian');

-- SELECT fsm_core.fsm_get_initial_state_nodes_v2('creditCheck', 'v2', 'machine.creditCheck.CheckingCreditScores.CheckingGavperian.CheckingForExistingReport');


-- Returns all initial state nodes and their proper ancestors up to (but not including) the given state node
CREATE OR REPLACE FUNCTION fsm_core.fsm_get_initial_state_nodes_with_ancestors_v2(
    p_fsm_name text,
    p_fsm_version text,
    p_state_path ltree
)
RETURNS text[] LANGUAGE plpgsql AS
$$
DECLARE
    initial_nodes text[];
    all_nodes text[] := ARRAY[]::text[];
    node text;
    ancestors text[];
BEGIN
    -- Get initial state nodes
    initial_nodes := fsm_core.fsm_get_initial_state_nodes_v2(p_fsm_name := p_fsm_name, p_fsm_version := p_fsm_version, p_state_path := p_state_path);

    -- Add initial nodes to result
    IF initial_nodes IS NOT NULL THEN
        all_nodes := initial_nodes;
        -- For each initial node, add its proper ancestors up to p_state_path
        FOREACH node IN ARRAY initial_nodes LOOP
            ancestors := fsm_core.get_proper_ancestors(state_path_ltree := node, to_state_path_ltree := p_state_path::text);
            IF ancestors IS NOT NULL THEN
                all_nodes := all_nodes || ancestors;
            END IF;
        END LOOP;
    END IF;

    -- Remove duplicates
    SELECT array_agg(DISTINCT n) INTO all_nodes FROM unnest(all_nodes) AS n;

    RETURN COALESCE(all_nodes, ARRAY[]::text[]);
END;
$$;

-- Example usage:
-- SELECT fsm_core.fsm_get_initial_state_nodes_with_ancestors_v2('creditCheck', 'v2', 'machine.creditCheck');

-- SELECT fsm_core.fsm_get_initial_state_nodes_with_ancestors_v2('creditCheck', 'v2', 'machine.creditCheck.CheckingCreditScores.CheckingGavperian');


-- Returns all state nodes from fsm_core.fsm_states for the given paths, fsm_name, and fsm_version
-- Enhanced: Iterates through all nodes, handles compound/parallel, collects initial state nodes with ancestors

CREATE OR REPLACE FUNCTION fsm_core.fsm_get_all_state_nodes_v2(
    p_state_paths text[],
    p_fsm_name text,
    p_fsm_version text
)
RETURNS text[] AS $$
DECLARE
    node_rec RECORD;
    child_rec RECORD;
    resultNodeset text[] := ARRAY[]::text[];
    initialStates text[];
    initialStateNode text;
    log_text TEXT := '';
    child_log TEXT;
    all_fsm_states fsm_core.fsm_states[];
    temp_flag BOOLEAN;
BEGIN
    RAISE NOTICE '[fsm_core.fsm_get_all_state_nodes_v2] Input state_paths: %', p_state_paths;
    
    SELECT array_agg(fsm_states ORDER BY fsm_order ASC) INTO all_fsm_states
    FROM fsm_core.fsm_states
    WHERE fsm_name = p_fsm_name AND fsm_version = p_fsm_version AND computed_state_key_ltree::text = ANY(p_state_paths);

    RAISE NOTICE '[fsm_core.fsm_get_all_state_nodes_v2] Matching fsm_core.fsm_states count: %', array_length(all_fsm_states, 1);

    FOR node_rec IN
        SELECT * FROM unnest(all_fsm_states) AS fsm_states
    LOOP
        log_text := log_text || format(E'\nProcessing node: %s (type=%s)', node_rec.computed_state_key_ltree, node_rec.type);
        RAISE NOTICE 'Processing node: % (type=%)', node_rec.computed_state_key_ltree, node_rec.type;
        IF node_rec.type = 'compound' THEN

            
            -- Check if node_rec.computed_state_key_ltree is immediate parent of any node in p_state_paths
            -- iterate through p_state_paths and check if any path has node_rec.computed_state_key_ltree as prefix (immediate parent)
            
            temp_flag := true;

            FOR child_rec IN SELECT * FROM unnest(all_fsm_states) AS fsm_states LOOP

                RAISE NOTICE 'Checking if node % is immediate parent of path %', node_rec.computed_state_key_ltree, child_rec.computed_state_key_ltree;
                IF node_rec.computed_state_key_ltree::text = child_rec.parent_node::text THEN
                    RAISE NOTICE 'Node % is immediate parent of path % so skipping its initial states...', node_rec.computed_state_key_ltree, child_rec.computed_state_key_ltree;
                    temp_flag := FALSE;
                    EXIT; -- No need to check further
                END IF;
            END LOOP;


            IF temp_flag THEN
                RAISE NOTICE 'Compound node % is not immediate parent of any path, adding initial states with ancestors...', node_rec.computed_state_key_ltree;
                initialStates := fsm_core.fsm_get_initial_state_nodes_with_ancestors_v2(p_fsm_name := p_fsm_name, p_fsm_version := p_fsm_version, p_state_path := node_rec.computed_state_key_ltree::ltree);
               
                RAISE NOTICE 'Initial states with ancestors for node %: %', node_rec.computed_state_key_ltree, initialStates;
                IF initialStates IS NOT NULL THEN
                    FOREACH initialStateNode IN ARRAY initialStates LOOP
                        IF initialStateNode IS NOT NULL AND NOT (initialStateNode = ANY(resultNodeset)) THEN
                            resultNodeset := array_append(resultNodeset, initialStateNode);
                            RAISE NOTICE 'Added initialStateNode: %', initialStateNode;
                           
                        END IF;
                    END LOOP;
                END IF;
            END IF;    
        ELSIF node_rec.type = 'parallel' THEN
            
            RAISE NOTICE 'Parallel node % found, iterating children...', node_rec.computed_state_key_ltree;
            IF node_rec.states IS NOT NULL THEN
                FOR child_rec IN SELECT value FROM jsonb_each(node_rec.states) LOOP
                    RAISE NOTICE 'Processing child node in parallel state: %', child_rec.value->>'id';
                    
                    initialStates := fsm_core.fsm_get_initial_state_nodes_with_ancestors_v2(p_fsm_name := p_fsm_name, p_fsm_version := p_fsm_version, p_state_path := fsm_core.sanitize_text_to_ltree(input_text := child_rec.value->>'id'));
                    RAISE NOTICE 'Initial states with ancestors for child node %: %', child_rec.value->>'id', initialStates;
                    
                    IF initialStates IS NOT NULL THEN
                        FOREACH initialStateNode IN ARRAY initialStates LOOP
                            IF initialStateNode IS NOT NULL AND NOT (initialStateNode = ANY(resultNodeset)) THEN
                                resultNodeset := array_append(resultNodeset, initialStateNode);
                                RAISE NOTICE 'Added child initialStateNode: %', initialStateNode;
                            END IF;
                        END LOOP;
                    END IF;
                END LOOP;
            END IF;
        ELSEIF node_rec.type = 'atomic' THEN
            
            RAISE NOTICE 'Atomic node % found, adding to resultNodeset...', node_rec.computed_state_key_ltree;
            resultNodeset := array_append(resultNodeset, node_rec.computed_state_key_ltree::text);
            
            RAISE NOTICE 'Added atomic node: %', node_rec.computed_state_key_ltree::text;
        ELSE
            log_text := log_text || E'\n  Node type is final/history or unknown, skipping it.';
            
        
        END IF;
    END LOOP;

   
    RAISE NOTICE '[fsm_core.fsm_get_all_state_nodes_v2] Log:%', log_text;
    RAISE NOTICE '[fsm_core.fsm_get_all_state_nodes_v2] ResultNodeset: %', resultNodeset;
    RETURN COALESCE(resultNodeset, ARRAY[]::text[]);
END;
$$ LANGUAGE plpgsql;


-- SELECT fsm_core.fsm_get_all_state_nodes_v2(
--     ARRAY[
--     'machine',
--     'machine.creditCheck',
--     'machine.creditCheck.Verifying_Credentials' 
--     ], 
--     'creditCheck', 
--     '20250102030405');


-- SELECT fsm_core.fsm_get_all_state_nodes_v2(
--     ARRAY[
--     'machine',
--     'machine.creditCheck',
--     'machine.creditCheck.CheckingCreditScores',
--     'machine.creditCheck.CheckingCreditScores.CheckingGavperian',
--     'machine.creditCheck.CheckingCreditScores.CheckingGavperian.CheckingForExistingReport'    
--     ], 
--     'creditCheck', 
--     '20250102030405');

-- SELECT jsonb_all_paths(
--     '{
    
--         "creditCheck" : {
--             "CheckingCreditScores": {
                
--                 "CheckingGavperian": "CheckingForExistingReport"
--             }
--         }
    
--     }'::jsonb,
--     '');




-- select fsm_core.fsm_get_all_state_nodes_v2(ARRAY[
--     'fp.p1',
--     'fp.p1.s1',
--     'fp.p1.s1.p2',
--     'fp.p1.s1.p2.s4',
--     'fp.p1.s2',
--     'fp.p1.s2.p4',
--     'fp.p1.s2.p4.s8'
-- ], 'fpTest', 'v2');

-- select fsm_core.fsm_get_all_state_nodes_v2(ARRAY[
--     'machine'
-- ], 'creditCheck', '20250102030405');



-- Returns all state nodes for all paths in a JSONB object using jsonb_all_paths and fsm_get_all_state_nodes

CREATE OR REPLACE FUNCTION fsm_core.resolve_state_value_v2(
    input_json JSONB,
    input_fsm_name TEXT,
    input_fsm_version TEXT
)
RETURNS JSONB AS $$
DECLARE
    root_node text;
    all_paths TEXT[];
    all_nodes TEXT[];
    nested_json JSONB;
    result_json JSONB;
    all_fsm_states fsm_core.fsm_states[];
    root_node_record fsm_core.fsm_states;
BEGIN
    -- Get root node for fsm_name and fsm_version (lowest fsm_order)
    -- SELECT computed_state_key_ltree INTO root_node
    -- FROM fsm_core.fsm_states
    -- WHERE fsm_name = input_fsm_name AND fsm_version = input_fsm_version
    -- ORDER BY fsm_order ASC
    -- LIMIT 1;

    -- RAISE NOTICE 'Root node: %', root_node;

    SELECT array_agg(fsm_states ORDER BY fsm_order ASC) INTO all_fsm_states
    FROM fsm_core.fsm_states
    WHERE fsm_name = input_fsm_name AND fsm_version = input_fsm_version;

    root_node_record := all_fsm_states[1]; -- Get the first record (lowest fsm_order) 
    
    root_node := root_node_record.computed_state_key_ltree::text; -- Extract the computed_state_key_ltree as text

    RAISE NOTICE 'Root node: %', root_node;

    -- Get all paths from the JSONB object, using root_node as prefix if found
    IF root_node IS NOT NULL THEN
        RAISE NOTICE 'Using root_node as prefix for jsonb_all_paths';
        all_paths := fsm_core.jsonb_all_paths(j := input_json, prefix := root_node);
    ELSE
        all_paths := fsm_core.jsonb_all_paths(j := input_json, prefix := '');
    END IF;

    RAISE NOTICE 'All paths: %', all_paths;
    -- Get all state nodes for these paths
    all_nodes := fsm_core.fsm_get_all_state_nodes_v2(p_state_paths := all_paths, p_fsm_name := input_fsm_name, p_fsm_version := input_fsm_version);

    RAISE NOTICE 'All nodes after fsm_core.fsm_get_all_state_nodes_v2: %', all_nodes;
    -- Build nested JSON from the state nodes
    nested_json := fsm_core.build_nested_json_recursive(paths := all_nodes);

    RAISE NOTICE 'Nested JSON: %', nested_json;

    -- Build a result object that contains both the nested JSON and the list of all nodes
    result_json := jsonb_build_object(
        'json', COALESCE(nested_json, '{}'::jsonb),
        'all_nodes', COALESCE(to_jsonb(all_nodes), '[]'::jsonb)
    );

    RAISE NOTICE 'Result JSON (json + all_nodes): %', result_json;

    RETURN result_json;
END;
$$ LANGUAGE plpgsql;

-- Example usage:
-- SELECT fsm_core.resolve_state_value_v2('{"p1":{"s1":{"p2":"s4"},"s2":{"p4":"s8"}}}'::jsonb, 'machineTest', 'v2');



-- SELECT fsm_core.resolve_state_value_v2('{}'::jsonb, 'creditCheck', 'v3');

-- SELECT fsm_core.resolve_state_value_v2('""'::jsonb, 'creditCheck', 'v3');

-- SELECT fsm_core.resolve_state_value_v2(null::jsonb, 'creditCheck', 'v3');

-- SELECT fsm_core.resolve_state_value_v2('{"creditCheck": "Entering_Information"}'::jsonb, 'creditCheck', 'v3');
-- SELECT fsm_core.resolve_state_value_v2('{"creditCheck": "Verifying_Credentials"}'::jsonb, 'creditCheck', 'v3');

