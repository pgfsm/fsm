
-- NEW SECTION: Sanitization functions for text to LTREE and arrays of text to arrays of LTREE

CREATE OR REPLACE FUNCTION fsm_core.remove_hashtag_from_text(input_text TEXT)
RETURNS TEXT AS $$
DECLARE
    sanitized_text TEXT;
BEGIN
   

    -- Step 1: Remove unwanted characters (#, (), etc.)
    sanitized_text := REGEXP_REPLACE(sanitized_text, '[#]', '', 'g');

   
    -- Step 4: Handle empty string case
    IF sanitized_text = '' THEN
        RETURN NULL;
    END IF;

    RETURN sanitized_text;
END;
$$ LANGUAGE plpgsql IMMUTABLE;


-- This function sanitizes a given text input to conform to LTREE format.
-- It performs the following steps:
-- 1. Replaces whitespace characters with underscores.
-- 2. Removes specific unwanted characters such as #, (), etc.
-- 3. Removes any characters not allowed in LTREE (only letters, numbers, underscores, dots, and hyphens are allowed).
-- 4. Converts the sanitized text to LTREE type.
-- If the input is NULL or results in an empty string after sanitization, the function returns NULL.
CREATE OR REPLACE FUNCTION fsm_core.sanitize_text_to_ltree(input_text TEXT)
RETURNS LTREE AS $$
DECLARE
    sanitized_text TEXT;
BEGIN
    -- Step 1: Replace whitespace with underscores
    sanitized_text := REGEXP_REPLACE(COALESCE(input_text, ''), '\s+', '_', 'g');

    -- Step 2: Remove unwanted characters (#, (), etc.)
    sanitized_text := REGEXP_REPLACE(sanitized_text, '[#()]', '', 'g');

    -- Step 3: Remove any characters not allowed in ltree (keep letters, numbers, _, ., -)
    sanitized_text := REGEXP_REPLACE(sanitized_text, '[^a-zA-Z0-9_.-]', '', 'g');

    -- Step 4: Handle empty string case
    IF sanitized_text = '' THEN
        RETURN NULL;
    END IF;

    RETURN sanitized_text::ltree;
END;
$$ LANGUAGE plpgsql IMMUTABLE;


-- Example usage and test cases:
SELECT fsm_core.sanitize_text_to_ltree('#text');
SELECT fsm_core.sanitize_text_to_ltree('#text ');

SELECT fsm_core.sanitize_text_to_ltree('text abcd');

SELECT fsm_core.sanitize_text_to_ltree('some#text with spaces()');

SELECT fsm_core.sanitize_text_to_ltree('[root.child.grandchild]');


-- This function takes an array of text inputs, sanitizes each element to conform to LTREE format using the fsm_core.sanitize_text_to_ltree function,
-- and returns an array of LTREE. If any element cannot be converted to LTREE, it is skipped.
-- If the input array is NULL, the function returns an empty LTREE array
CREATE OR REPLACE FUNCTION fsm_core.sanitize_text_array_to_ltree_array(input_array TEXT[])
RETURNS LTREE[] AS $$
DECLARE
    result LTREE[];
    element TEXT;
    sanitized_ltree LTREE;
BEGIN
    result := ARRAY[]::LTREE[];
    
    -- Handle NULL input
    IF input_array IS NULL THEN
        RETURN result;
    END IF;
    
    -- Process each element in the array using fsm_core.sanitize_text_to_ltree
    FOREACH element IN ARRAY input_array
    LOOP
        sanitized_ltree := fsm_core.sanitize_text_to_ltree(input_text := element);
        
        -- Add to result if sanitization was successful
        IF sanitized_ltree IS NOT NULL THEN
            result := array_append(result, sanitized_ltree);
        END IF;
    END LOOP;
    
    RETURN result;
-- EXCEPTION
--     WHEN OTHERS THEN
--         -- If any conversion fails, return empty array
--         RETURN ARRAY[]::LTREE[];
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Example usage and test cases:
select fsm_core.sanitize_text_array_to_ltree_array(ARRAY['abcd #text','(machine)']);

-- negative test case: Empty Array input
-- select fsm_core.sanitize_text_array_to_ltree_array(ARRAY[]);
-- output: HINT: Explicitly cast to the desired type, for example ARRAY[]::integer[]

-- This function takes an array of text inputs, sanitizes each element to conform to LTREE format using the fsm_core.sanitize_text_to_ltree function,
-- and returns an array of TEXT. If any element cannot be converted to LTREE, it is skipped.
-- If the input array is NULL, the function returns an empty TEXT array
CREATE OR REPLACE FUNCTION fsm_core.sanitize_text_array_to_ltree_text_array(input_array TEXT[])
RETURNS TEXT[] AS $$
DECLARE
    result TEXT[];
    element TEXT;
    sanitized_ltree LTREE;
BEGIN
    result := ARRAY[]::TEXT[];
    
    -- Handle NULL input
    IF input_array IS NULL THEN
        RETURN result;
    END IF;
    
    -- Process each element in the array using fsm_core.sanitize_text_to_ltree
    FOREACH element IN ARRAY input_array
    LOOP
        sanitized_ltree := fsm_core.sanitize_text_to_ltree(input_text := element);
        
        -- Add to result if sanitization was successful
        IF sanitized_ltree IS NOT NULL THEN
            result := array_append(result, sanitized_ltree::TEXT);
        END IF;
    END LOOP;
    
    RETURN result;
-- EXCEPTION
--     WHEN OTHERS THEN
--         -- If any conversion fails, return empty array
--         RETURN ARRAY[]::LTREE[];
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Example usage and test cases:
select fsm_core.sanitize_text_array_to_ltree_text_array(ARRAY['abcd #text','(machine)']);

-- NEW section LCA 

-- TODO: NOTE: lca method of ltree extension does not work as expected.
-- https://www.postgresql.org/message-id/29778.1531522452%40sss.pgh.pa.us

SELECT lca(ARRAY['a'::ltree, 'a.b.c'::ltree, 'a.b.c.f'::ltree]);
-- lca of above should be 'a' but returns NULL

-- This function takes an array of LTREE paths and returns their lowest common ancestor (LCA) as an LTREE.
-- If the input array is empty or NULL, the function returns NULL.
-- If there is no common ancestor, the function returns NULL.
CREATE OR REPLACE FUNCTION fsm_core.sql_lca_from_array(paths ltree[]) RETURNS ltree AS $$
  SELECT ancestor
  FROM (
    SELECT subpath(paths[1], 0, i) AS ancestor, i
    FROM generate_series(1, nlevel(paths[1])) AS i
  ) AS candidates
  WHERE NOT EXISTS (
    SELECT 1
    FROM unnest(paths) AS input(p)
    WHERE NOT (candidates.ancestor @> input.p)
  )
  ORDER BY candidates.i DESC
  LIMIT 1;
$$ LANGUAGE sql IMMUTABLE STRICT;

-- Example usage and test cases:

-- edge case: when first input is root it should return root
SELECT fsm_core.sql_lca_from_array(ARRAY['a'::ltree, 'a.b.c'::ltree, 'a.b.c.f'::ltree]);
-- output: 'a'

-- positive test case: common ancestor exists
SELECT fsm_core.sql_lca_from_array(ARRAY['a.b.c.d'::ltree, 'a.b.c.e'::ltree, 'a.b.c.f'::ltree]);
-- output: 'a.b.c'

-- negative test case: no common ancestor
SELECT fsm_core.sql_lca_from_array(ARRAY['a.b.c.d'::ltree, 'x.y.z'::ltree]);
-- output: NULL



-- Returns all proper ancestors of state_path_ltree, stopping before to_state_path_ltree (exclusive).
-- Assumes both inputs are already ltree type.
-- hint: from child to parent until to_state_path_ltree
CREATE OR REPLACE FUNCTION fsm_core.get_proper_ancestors_ltree(
    state_path_ltree ltree,
    to_state_path_ltree ltree
) RETURNS ltree[] AS $$
DECLARE
    ancestors ltree[] := ARRAY[]::ltree[];
    parent_path ltree;
BEGIN
    -- If both are equal, return empty array
    IF state_path_ltree = to_state_path_ltree THEN
        RETURN ancestors;
    END IF;

    -- Start from the immediate parent
    parent_path := subpath(state_path_ltree, 0, nlevel(state_path_ltree) - 1);

    WHILE nlevel(parent_path) > 0 AND parent_path <> to_state_path_ltree LOOP
        ancestors := array_append(ancestors, parent_path);
        parent_path := subpath(parent_path, 0, nlevel(parent_path) - 1);
    END LOOP;

    RETURN ancestors;
END;
$$ LANGUAGE plpgsql IMMUTABLE;


-- Returns all proper ancestors of state_path_ltree, stopping before to_state_path_ltree (exclusive).
CREATE OR REPLACE FUNCTION fsm_core.get_proper_ancestors(
    state_path_ltree TEXT,
    to_state_path_ltree TEXT
) RETURNS TEXT[] AS $$
DECLARE
    ancestors TEXT[] := ARRAY[]::TEXT[];
    current_path ltree;
    to_path ltree;
    parent_path ltree;
BEGIN
    -- Convert input to ltree
    current_path := state_path_ltree::ltree;
    to_path := to_state_path_ltree::ltree;

    -- If both are equal, return empty array
    IF current_path = to_path THEN
        RETURN ancestors;
    END IF;

    -- Walk up the tree, collecting parents, until to_path or root
    parent_path := subpath(current_path, 0, nlevel(current_path) - 1);

    WHILE nlevel(parent_path) > 0 AND parent_path <> to_path LOOP
        ancestors := array_append(ancestors, parent_path::TEXT);
        parent_path := subpath(parent_path, 0, nlevel(parent_path) - 1);
    END LOOP;

    RETURN ancestors;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

