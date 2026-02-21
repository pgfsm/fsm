-- DEPRECATED: NOT_USED :: fsm_get_all_initial_nodes_for_compound_nodes is not in use as its considering all elements of initial->'target' and only works for compound
CREATE OR REPLACE FUNCTION fsm_get_all_initial_nodes_for_compound_nodes(
    root_id TEXT,
    input_fsm_name TEXT,
    input_fsm_version TEXT
)
RETURNS LTREE[] AS $$
DECLARE
    result LTREE[];
    log_text TEXT;
    resolved_nodes TEXT;
BEGIN
    WITH RECURSIVE initial_nodes AS (
        -- Start from the root node
        SELECT 
            computed_state_id_ltree,
            id,
            COALESCE(
                sanitize_text_array_to_ltree_array(
                    ARRAY(SELECT jsonb_array_elements_text(initial->'target'))
                ),
                ARRAY[]::ltree[]
            ) AS targets
        FROM fsm_states
        WHERE computed_state_id_ltree = root_id::ltree
          AND fsm_name = input_fsm_name
          AND fsm_version = input_fsm_version

        UNION ALL

        -- Traverse through target nodes
        SELECT 
            s.computed_state_id_ltree,
            s.id,
            COALESCE(
                sanitize_text_array_to_ltree_array(
                    ARRAY(SELECT jsonb_array_elements_text(s.initial->'target'))
                ),
                ARRAY[]::ltree[]
            ) AS targets
        FROM fsm_states s
        JOIN initial_nodes n 
          ON s.computed_state_id_ltree <@ ANY (n.targets)
        WHERE s.fsm_name = input_fsm_name
          AND s.fsm_version = input_fsm_version
    )
    SELECT 
        ARRAY_AGG(computed_state_id_ltree),
        string_agg(
            format('Node id=%s path=%s targets={%s}', 
                   id, computed_state_id_ltree::text, array_to_string(targets, ',')),
            E'\n'
        ),
        string_agg(computed_state_id_ltree::text, ', ')
    INTO result, log_text, resolved_nodes
    FROM initial_nodes;

    -- Print traversal logs
    IF log_text IS NOT NULL THEN
        RAISE NOTICE 'Initial nodes traversal:%', E'\n' || log_text;
    END IF;

    -- Print resolved node summary
    IF resolved_nodes IS NOT NULL THEN
        RAISE NOTICE 'Resolved initial nodes: %', resolved_nodes;
    END IF;

    RETURN COALESCE(result, ARRAY[]::LTREE[]);
END;
$$ LANGUAGE plpgsql STABLE;



-- SELECT fsm_get_all_initial_nodes_for_compound_nodes('machine.creditCheck', 'creditCheckNiraj', 'v1');

-- SELECT fsm_get_all_initial_nodes_for_compound_nodes('machine.creditCheck.CheckingCreditScores', 'creditCheckNiraj', 'v1');



-- this function returns all initial state nodes reachable from the given state node,
-- including handling nested compound and parallel states
CREATE OR REPLACE FUNCTION fsm_get_initial_state_nodes_v1(
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
                THEN sanitize_to_ltree(s.initial->'target'->>0)::ltree

                WHEN s.type = 'parallel'
                     AND s.states IS NOT NULL
                THEN (t.node_path::text || '.' || sanitize_to_ltree(c.value->>'key')::text)::ltree

                ELSE NULL
            END AS next_path
        FROM traverse t
        JOIN fsm_states s
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

-- SELECT fsm_get_initial_state_nodes_v1('creditCheckNiraj', 'v1', 'machine.creditCheck');

-- SELECT fsm_get_initial_state_nodes_v1('creditCheckNiraj', 'v1', 'machine.creditCheck.CheckingCreditScores');

-- SELECT fsm_get_initial_state_nodes_v1('creditCheckNiraj', 'v1', 'machine.creditCheck.CheckingCreditScores.CheckingGavperian');

-- SELECT fsm_get_initial_state_nodes_v1('creditCheckNiraj', 'v1', 'machine.creditCheck.CheckingCreditScores.CheckingGavperian.CheckingForExistingReport');


-- Returns all initial state nodes and their proper ancestors up to (but not including) the given state node
CREATE OR REPLACE FUNCTION fsm_get_initial_state_nodes_with_ancestors_v1(
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
    initial_nodes := fsm_get_initial_state_nodes_v1(p_fsm_name, p_fsm_version, p_state_path);

    -- Add initial nodes to result
    IF initial_nodes IS NOT NULL THEN
        all_nodes := initial_nodes;
        -- For each initial node, add its proper ancestors up to p_state_path
        FOREACH node IN ARRAY initial_nodes LOOP
            ancestors := get_proper_ancestors(node, p_state_path::text);
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
-- SELECT fsm_get_initial_state_nodes_with_ancestors_v1('creditCheckNiraj', 'v1', 'machine.creditCheck');

-- SELECT fsm_get_initial_state_nodes_with_ancestors_v1('creditCheckNiraj', 'v1', 'machine.creditCheck.CheckingCreditScores.CheckingGavperian');


-- Returns all state nodes from fsm_states for the given paths, fsm_name, and fsm_version
-- Enhanced: Iterates through all nodes, handles compound/parallel, collects initial state nodes with ancestors

CREATE OR REPLACE FUNCTION fsm_get_all_state_nodes_v1(
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
BEGIN
    RAISE NOTICE '[fsm_get_all_state_nodes_v1] Input state_paths: %', p_state_paths;
    FOR node_rec IN
        SELECT *
        FROM fsm_states
        WHERE computed_state_key_ltree::text = ANY(p_state_paths)
          AND fsm_name = p_fsm_name
          AND fsm_version = p_fsm_version
    LOOP
        log_text := log_text || format(E'\nProcessing node: %s (type=%s)', node_rec.computed_state_key_ltree, node_rec.type);
        IF node_rec.type = 'compound' THEN
            initialStates := fsm_get_initial_state_nodes_with_ancestors_v1(p_fsm_name, p_fsm_version, node_rec.computed_state_key_ltree::ltree);
            log_text := log_text || format(E'\n  Compound node, initialStates: %s', initialStates);
            IF initialStates IS NOT NULL THEN
                FOREACH initialStateNode IN ARRAY initialStates LOOP
                    IF initialStateNode IS NOT NULL AND NOT (initialStateNode = ANY(resultNodeset)) THEN
                        resultNodeset := array_append(resultNodeset, initialStateNode);
                        log_text := log_text || format(E'\n    Added initialStateNode: %s', initialStateNode);
                    END IF;
                END LOOP;
            END IF;
        ELSIF node_rec.type = 'parallel' THEN
            log_text := log_text || E'\n  Parallel node, iterating children...';
            IF node_rec.states IS NOT NULL THEN
                FOR child_rec IN SELECT value FROM jsonb_each(node_rec.states) LOOP
                    log_text := log_text || format(E'\n    Child id: %s', child_rec.value->>'id');
                    initialStates := fsm_get_initial_state_nodes_with_ancestors_v1(p_fsm_name, p_fsm_version, sanitize_to_ltree(child_rec.value->>'id'));
                    log_text := log_text || format(E'\n      Child initialStates: %s', initialStates);
                    IF initialStates IS NOT NULL THEN
                        FOREACH initialStateNode IN ARRAY initialStates LOOP
                            IF initialStateNode IS NOT NULL AND NOT (initialStateNode = ANY(resultNodeset)) THEN
                                resultNodeset := array_append(resultNodeset, initialStateNode);
                                log_text := log_text || format(E'\n        Added child initialStateNode: %s', initialStateNode);
                            END IF;
                        END LOOP;
                    END IF;
                END LOOP;
            END IF;
        ELSE
            log_text := log_text || E'\n  Node is not compound or parallel, skipping.';
        END IF;
    END LOOP;

    RAISE NOTICE '[fsm_get_all_state_nodes_v1] ResultNodeset: %', resultNodeset;
    RAISE NOTICE '[fsm_get_all_state_nodes_v1] Log:%', log_text;
    RETURN COALESCE(resultNodeset, ARRAY[]::text[]);
END;
$$ LANGUAGE plpgsql;


-- SELECT fsm_get_all_state_nodes_v1(ARRAY['machine.creditCheck.CheckingCreditScores.CheckingGavperian'], 'creditCheckNiraj', 'v1');

-- select fsm_get_all_state_nodes_v1(ARRAY[
--     'fp.p1',
--     'fp.p1.s1',
--     'fp.p1.s1.p2',
--     'fp.p1.s1.p2.s4',
--     'fp.p1.s2',
--     'fp.p1.s2.p4',
--     'fp.p1.s2.p4.s8'
-- ], 'fpTest', 'v1');



-- Returns all state nodes for all paths in a JSONB object using jsonb_all_paths and fsm_get_all_state_nodes_v1

CREATE OR REPLACE FUNCTION resolveStateValue_v1(
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
BEGIN
    -- Get root node for fsm_name and fsm_version (lowest fsm_order)
    SELECT computed_state_key_ltree INTO root_node
    FROM fsm_states
    WHERE fsm_name = input_fsm_name AND fsm_version = input_fsm_version
    ORDER BY fsm_order ASC
    LIMIT 1;

    RAISE NOTICE 'Root node: %', root_node;

    -- Get all paths from the JSONB object, using root_node as prefix if found
    IF root_node IS NOT NULL THEN
        all_paths := jsonb_all_paths(input_json, root_node);
    ELSE
        all_paths := jsonb_all_paths(input_json, '');
    END IF;

    RAISE NOTICE 'All paths: %', all_paths;
    -- Get all state nodes for these paths
    all_nodes := fsm_get_all_state_nodes_v1(all_paths, input_fsm_name, input_fsm_version);

    RAISE NOTICE 'All nodes after fsm_get_all_state_nodes_v1: %', all_nodes;
    -- Build nested JSON from the state nodes
    nested_json := build_nested_json_recursive(all_nodes);

    RAISE NOTICE 'Nested JSON: %', nested_json;

    RETURN nested_json;
END;
$$ LANGUAGE plpgsql;

-- Example usage:
-- SELECT resolveStateValue_v1('{"p1":{"s1":{"p2":"s4"},"s2":{"p4":"s8"}}}'::jsonb, 'machineTest', 'v1');



