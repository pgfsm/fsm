-- DEPRECATED: This function is no longer in use. Use <new_function_name> instead if applicable.
CREATE OR REPLACE FUNCTION path_to_jsonb(parts TEXT[])
RETURNS JSONB AS $$
DECLARE
  result JSONB;
BEGIN
  IF array_length(parts, 1) = 1 THEN
    RETURN jsonb_build_object(parts[1], NULL);
  ELSIF array_length(parts, 1) = 2 THEN
    RETURN jsonb_build_object(parts[1], parts[2]);
  ELSE
    RETURN jsonb_build_object(parts[1], path_to_jsonb(parts[2:]));
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Example usage:

-- positive test case
SELECT path_to_jsonb(ARRAY['machine', 'creditCheck', 'Entering Information', 'CheckingCreditScores', 'CheckingEquiGavin']);
-- output: {"machine": {"creditCheck": {"Entering Information": {"CheckingCreditScores": "CheckingEquiGavin"}}}}


-- edge case: empty string array input
SELECT path_to_jsonb(ARRAY['']);
-- output: {"": null}

-- negative test case: empty array input
-- SELECT path_to_jsonb(ARRAY[]);
-- output: error:  HINT: Explicitly cast to the desired type, for example ARRAY[]::integer[]

-- negative test case: NULL input
-- SELECT path_to_jsonb(NULL);
-- output: error: stack depth limit exceeded


-- this function converts a dot-separated path string into a nested JSONB object
-- e.g. 'machine.creditCheck.Entering Information.CheckingCreditScores.CheckingEquiGavin'
-- becomes
-- {
--   "machine": {
--     "creditCheck": {
--       "Entering Information": {
--         "CheckingCreditScores": "CheckingEquiGavin"
--       }
--     }
--   }
-- }
CREATE OR REPLACE FUNCTION path_string_to_jsonb(path TEXT)
RETURNS JSONB AS $$
DECLARE
  parts TEXT[];
BEGIN
  IF path IS NULL OR trim(path) = '' THEN
    RETURN '{}'::JSONB;
  END IF;
  parts := string_to_array(path, '.');
  IF array_length(parts, 1) = 1 THEN
    RETURN jsonb_build_object(parts[1], NULL);
  ELSIF array_length(parts, 1) = 2 THEN
    RETURN jsonb_build_object(parts[1], parts[2]::text); -- Cast to text, not JSON string
  ELSE
    RETURN jsonb_build_object(parts[1], path_string_to_jsonb(array_to_string(parts[2:], '.')));
  END IF;
END;
$$ LANGUAGE plpgsql;

-- example usage:
-- positive test case
SELECT path_string_to_jsonb('machine.creditCheck.Entering Information.CheckingCreditScores.CheckingEquiGavin');
-- output: {"machine": {"creditCheck": {"Entering Information": {"CheckingCreditScores": "CheckingEquiGavin"}}}}

-- edge case: empty string input
SELECT path_string_to_jsonb('');
-- output: {}

-- negative test case: NULL input
SELECT path_string_to_jsonb(NULL);
-- output: {}

-- edge case: single segment path
SELECT path_string_to_jsonb('root');
-- output: {"root": null}


-- This function deeply merges two JSONB objects.
-- If one value is an object and the other is a scalar, it adds the scalar as a key with a null value.
-- Example:
-- SELECT jsonb_deep_merge(
--   '{"a": {"b": "value1"}}'::jsonb,
--   '{"a": "value2", "c": {"d": "value3"}}'::jsonb
-- );
CREATE OR REPLACE FUNCTION jsonb_deep_merge(a jsonb, b jsonb)
RETURNS jsonb AS $$
DECLARE
    key_ text;
    aval jsonb;
    bval jsonb;
    merged jsonb := a;
    scalar_key text;
BEGIN
    IF a IS NULL THEN
        RETURN b;
    ELSIF b IS NULL THEN
        RETURN a;
    END IF;

    IF jsonb_typeof(a) = 'object' AND jsonb_typeof(b) = 'object' THEN
        FOR key_, bval IN
            SELECT key AS key_, value AS bval FROM jsonb_each(b)
        LOOP
            aval := a->key_;
            IF aval IS NULL THEN
                merged := jsonb_set(merged, ARRAY[key_], bval, true);
            ELSE
                IF jsonb_typeof(aval) = 'object' AND jsonb_typeof(bval) <> 'object' THEN
                    -- merge object and scalar: add scalar as key with null value
                    IF jsonb_typeof(bval) = 'string' THEN
                        scalar_key := trim(both '"' from bval::text);
                    ELSE
                        scalar_key := bval::text;
                    END IF;
                    merged := jsonb_set(
                        merged,
                        ARRAY[key_],
                        jsonb_deep_merge(aval, jsonb_build_object(scalar_key, NULL)),
                        true
                    );
                ELSIF jsonb_typeof(aval) <> 'object' AND jsonb_typeof(bval) = 'object' THEN
                    -- merge scalar and object: add scalar as key with null value
                    IF jsonb_typeof(aval) = 'string' THEN
                        scalar_key := trim(both '"' from aval::text);
                    ELSE
                        scalar_key := aval::text;
                    END IF;
                    merged := jsonb_set(
                        merged,
                        ARRAY[key_],
                        jsonb_deep_merge(jsonb_build_object(scalar_key, NULL), bval),
                        true
                    );
                ELSE
                    merged := jsonb_set(
                        merged,
                        ARRAY[key_],
                        jsonb_deep_merge(aval, bval),
                        true
                    );
                END IF;
            END IF;
        END LOOP;
        RETURN merged;
    ELSE
        RETURN b;
    END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- example usage:
-- positive test case
-- simaple merge with last one winning for overlapping keys
SELECT jsonb_deep_merge(
  '{"a": "value1"}'::jsonb,
  '{"a": "value2"}'::jsonb
);
-- output: {"a": "value2"}

-- merging object with different keys
-- hint : a as parrallel state in state machine
SELECT jsonb_deep_merge(
  '{"a": {"b": "value1"}}'::jsonb,
  '{"a": {"c": "value2"}}'::jsonb
);
-- output: {"a": {"b": "value1", "c": "value2"}}

-- merging object and scalar: adds scalar as key with null value
SELECT jsonb_deep_merge(
  '{"a": {"b": "value1"}}'::jsonb,
  '{"a": "value2", "c": {"d": "value3"}}'::jsonb
);
-- output: {"a": {"b": "value1", "value2": null}, "c": {"d": "value3"}}

-- edge case: merging with NULL
SELECT jsonb_deep_merge(
  '{"a": "value2"}'::jsonb,
  NULL
);
-- output: {"a": "value2"}

-- edge case: merging NULL with NULL
SELECT jsonb_deep_merge(
  NULL,
  NULL
);
-- output: NULL

-- edge case: merging with empty object
SELECT jsonb_deep_merge(
  '{"a": "value2"}'::jsonb,
  '{}'::jsonb
);
-- output: {"a": "value2"}

-- edge case: merging empty object with empty object
SELECT jsonb_deep_merge(
  '{}'::jsonb,
  '{}'::jsonb
);
-- output: {}

-- edge case: merging empty object with NULL
SELECT jsonb_deep_merge(
  '{}'::jsonb,
  NULL
);
-- output: {}

-- edge case: merging object with non-object (scalar)
-- TODO: decide if this is the desired behavior or if we should return the object instead
-- or raise an error when scalar is passed as second argument
SELECT jsonb_deep_merge(
  '{"a": "value2"}'::jsonb,
  '"just a string"'::jsonb
);
-- output: "just a string"


SELECT jsonb_deep_merge(
  '"just a string"'::jsonb,
  '{"a": "value2"}'::jsonb
);
-- output: {"a": "value2"}


-- This function takes an array of dot-separated path strings and builds a single nested JSONB object.
-- It uses the path_string_to_jsonb function to convert each path string into a nested JSONB object,
-- and then merges them together using the jsonb_deep_merge function.
-- useful to build a nested jsonb  object from an array of paths.
-- array paths are stored as column in the fsm_states table.
CREATE OR REPLACE FUNCTION build_nested_json_recursive(paths TEXT[])
RETURNS JSONB AS $$
DECLARE
  result JSONB := '{}'::JSONB;
  path TEXT;
  sorted_paths TEXT[];
BEGIN
  -- Handle NULL input
  IF paths IS NULL THEN
    RETURN result;
  END IF;

  -- Sort paths by their character length (shorter paths first).
  -- Also filter out NULL or empty-string elements to avoid creating "null" keys.
  SELECT array_agg(p) INTO sorted_paths
  FROM (
    SELECT p
    FROM unnest(paths) AS p
    WHERE p IS NOT NULL AND trim(p) <> ''
    ORDER BY char_length(p) ASC
  ) s;

  -- If nothing remains after filtering, return empty object
  IF sorted_paths IS NULL THEN
    RETURN result;
  END IF;

  FOREACH path IN ARRAY sorted_paths LOOP
    result := jsonb_deep_merge(result, path_string_to_jsonb(path));
  END LOOP;

  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Example usage:
-- positive test case
SELECT build_nested_json_recursive(ARRAY[
  'machine',
  'machine.creditCheck',
  'machine.creditCheck.Entering Information',
  'machine.creditCheck.Entering Information.CheckingCreditScores',
  'machine.creditCheck.Entering Information.CheckingCreditScores.CheckingEquiGavin'
]);
-- output: {"machine": {"creditCheck": {"Entering Information": {"CheckingCreditScores": {"CheckingEquiGavin": null}}}}}

-- simple test case with single path
SELECT build_nested_json_recursive(ARRAY[
  'machine'
]);
-- output: {"machine": null}

-- test case with overlapping paths
SELECT build_nested_json_recursive(ARRAY[
  'machine',
  'machine.creditCheck',
  'machine.creditCheck.Entering Information',
  'machine.creditCheck.CheckingCreditScores'
]);
-- output: {"machine": {"creditCheck": "CheckingCreditScores"}}

-- test case with real example
SELECT build_nested_json_recursive(ARRAY[
  'machine',
  'machine.creditCheck',
  'machine.creditCheck.CheckingCreditScores',
  'machine.creditCheck.CheckingCreditScores.CheckingEquiGavin',
  'machine.creditCheck.CheckingCreditScores.CheckingGavUnion',
  'machine.creditCheck.CheckingCreditScores.CheckingGavperian',
  'machine.creditCheck.CheckingCreditScores.CheckingEquiGavin.CheckingForExistingReport',
  'machine.creditCheck.CheckingCreditScores.CheckingGavUnion.CheckingForExistingReport',
  'machine.creditCheck.CheckingCreditScores.CheckingGavperian.CheckingForExisting'
]);
-- output: 
-- {
--     "machine": {
--         "creditCheck": {
--             "CheckingCreditScores": {
--                 "CheckingGavUnion": "CheckingForExistingReport",
--                 "CheckingEquiGavin": "CheckingForExistingReport",
--                 "CheckingGavperian": "CheckingForExisting"
--             }
--         }
--     }
-- }


-- TODO: add sorting to the paths before processing to ensure
-- negative case: paths are not in order
SELECT build_nested_json_recursive(ARRAY[
  'machine',
  'machine.creditCheck',
  'machine.creditCheck.CheckingCreditScores',
  'machine.creditCheck.CheckingCreditScores.CheckingEquiGavin',
  'machine.creditCheck.CheckingCreditScores.CheckingEquiGavin.CheckingForExistingReport',
  'machine.creditCheck.CheckingCreditScores.CheckingGavUnion',
  'machine.creditCheck.CheckingCreditScores.CheckingGavperian.CheckingForExisting',
  'machine.creditCheck.CheckingCreditScores.CheckingGavperian',
  'machine.creditCheck.CheckingCreditScores.CheckingGavUnion.CheckingForExistingReport'
]);
-- output:
-- {
--     "machine": {
--         "creditCheck": {
--             "CheckingCreditScores": {
--                 "CheckingGavUnion": "CheckingForExistingReport",
--                 "CheckingEquiGavin": "CheckingForExistingReport",
--                 "CheckingGavperian": null
--             }
--         }
--     }
-- }


-- TODO: add sorting to the paths before processing to ensure correct nesting
-- or handle out-of-order paths gracefully in the function itself
-- edge case: when paths are not in order
SELECT build_nested_json_recursive(ARRAY[
  'machine',
  'machine.creditCheck.Entering Information.CheckingCreditScores.CheckingEquiGavin',
  'machine.creditCheck.Entering Information',
  'machine.creditCheck',
  'machine.creditCheck.Entering Information.CheckingCreditScores'
]);
-- output: 
-- {
--     "machine": {
--         "null": null,
--         "creditCheck": {
--             "null": null,
--             "Entering Information": {
--                 "null": null,
--                 "CheckingCreditScores": null
--             }
--         }
--     }
-- }


-- negative case: empty array input
-- SELECT build_nested_json_recursive(ARRAY[]);
-- output: HINT: Explicitly cast to the desired type, for example ARRAY[]::integer[].

-- negative case: NULL input
SELECT build_nested_json_recursive(ARRAY['machine', NULL]);
-- output: {"machine": null}
SELECT build_nested_json_recursive(ARRAY['', NULL]);
-- output: {}
SELECT build_nested_json_recursive(ARRAY['', '']);
-- output: {}
-- SELECT build_nested_json_recursive(NULL);
-- output: error: FOREACH expression must not be null
-- CONTEXT: PL/pgSQL function build_nested_json_recursive(text[]) line 6 at FOREACH over array



-- This function extracts all paths from a JSONB object and returns them as an array of text.
-- Each path represents the hierarchy of keys leading to each value in the JSONB object.
-- also add prefix to each path if provided.
-- For example, given the JSONB object:
-- {
--   "creditCheck": {
--     "CheckingCreditScores": {
--       "CheckingEquiGavin": "CheckingForExistingReport",
--       "CheckingGavUnion": "CheckingForExistingReport",
--       "CheckingGavperian": "CheckingForExistingReport"
--     }
--   }
-- }
-- The function will return the following array of paths:
-- [
--   "creditCheck",
--   "creditCheck.CheckingCreditScores",
--   "creditCheck.CheckingCreditScores.CheckingEquiGavin",
--   "creditCheck.CheckingCreditScores.CheckingEquiGavin.CheckingForExistingReport",
--   "creditCheck.CheckingCreditScores.CheckingGavUnion",
--   "creditCheck.CheckingCreditScores.CheckingGavUnion.CheckingForExistingReport",
--   "creditCheck.CheckingCreditScores.CheckingGavperian",
--   "creditCheck.CheckingCreditScores.CheckingGavperian.CheckingForExistingReport"
-- ]        


CREATE OR REPLACE FUNCTION jsonb_all_paths(j jsonb, prefix text DEFAULT '')
RETURNS text[] LANGUAGE plpgsql AS $$
DECLARE
    result text[] := ARRAY[]::text[];
    rec record;
    new_prefix text;
BEGIN
  -- Guard against NULL input
  -- IF j IS NULL THEN
  --   RETURN result;
  -- END IF;
  
  IF jsonb_typeof(j) = 'object' THEN
    -- if length of object is zero, return the current prefix as only path
    IF j = '{}'::jsonb THEN
      RAISE NOTICE 'Empty object encountered at prefix: %', prefix;
      IF prefix = '' THEN
        RETURN ARRAY[]::text[];
      ELSE
        RETURN ARRAY[prefix];
      END IF;
    ELSE
      FOR rec IN SELECT key, value FROM jsonb_each(j) LOOP
              new_prefix := CASE WHEN prefix = '' THEN rec.key ELSE prefix || '.' || rec.key END;
              RAISE NOTICE 'Current prefix: %', new_prefix;
              result := result || new_prefix;
              RAISE NOTICE 'current result array: %', result;
              RAISE NOTICE 'Recursing into value: % with new prefix: %', rec.value, new_prefix;
              result := result || jsonb_all_paths(rec.value, new_prefix);
      END LOOP;
    END IF;  
        
        
  ELSIF jsonb_typeof(j) = 'array' THEN
        -- Optionally handle arrays if needed
  ELSE
        RAISE NOTICE 'Leaf value reached at prefix: % and json value: %', prefix, j;
        -- -- It's a leaf value, append the value to the path
        IF j IS NULL THEN
            RAISE NOTICE 'Leaf value is NULL at prefix: %', prefix;
            result := result || prefix;
        ELSE
          IF prefix <> '' THEN
              -- result := result || (prefix || '.' || j::text);
              RAISE NOTICE 'Appending leaf value to path:';
              result := result || (prefix || '.' || trim(both '"' from j::text));
          ELSE
              RAISE NOTICE 'Appending leaf value to path with no prefix:';
              result := result || trim(both '"' from j::text);
          END IF;
        END IF;  
        
  END IF;
    RETURN result;
END;
$$;


-- Example usage:
-- positive test case
SELECT jsonb_all_paths('{
  "creditCheck": {
    "CheckingCreditScores": {
      "CheckingEquiGavin": "CheckingForExistingReport",
      "CheckingGavUnion": "CheckingForExistingReport",
      "CheckingGavperian": "CheckingForExistingReport"
    }
  }
}'::jsonb,'');
-- output:
-- [
--   "creditCheck",
--   "creditCheck.CheckingCreditScores",
--   "creditCheck.CheckingCreditScores.CheckingEquiGavin",
--   "creditCheck.CheckingCreditScores.CheckingEquiGavin.CheckingForExistingReport",
--   "creditCheck.CheckingCreditScores.CheckingGavUnion",
--   "creditCheck.CheckingCreditScores.CheckingGavUnion.CheckingForExistingReport",
--   "creditCheck.CheckingCreditScores.CheckingGavperian",
--   "creditCheck.CheckingCreditScores.CheckingGavperian.CheckingForExistingReport"
-- ]  


SELECT jsonb_all_paths('{
  "creditCheck": {
    "CheckingCreditScores": {
      "CheckingEquiGavin": "CheckingForExistingReport",
      "CheckingGavUnion": "CheckingForExistingReport",
      "CheckingGavperian": "CheckingForExistingReport"
    }
  }
}'::jsonb,'root');
-- output:
-- [
--   "root.creditCheck",
--   "root.creditCheck.CheckingCreditScores",
--   "root.creditCheck.CheckingCreditScores.CheckingEquiGavin",
--   "root.creditCheck.CheckingCreditScores.CheckingEquiGavin.CheckingForExistingReport",
--   "root.creditCheck.CheckingCreditScores.CheckingGavUnion",
--   "root.creditCheck.CheckingCreditScores.CheckingGavUnion.CheckingForExistingReport",
--   "root.creditCheck.CheckingCreditScores.CheckingGavperian",
--   "root.creditCheck.CheckingCreditScores.CheckingGavperian.CheckingForExistingReport"
-- ] 


SELECT jsonb_all_paths('{
  "creditCheck": {
    "CheckingCreditScores": {
      "CheckingEquiGavin": "CheckingForExistingReport",
      "CheckingGavUnion": "CheckingForExistingReport",
      "CheckingGavperian": "CheckingForExistingReport"
    }
  }
}'::jsonb,'root.child');
-- output:
-- [
--   "root.child.creditCheck",
--   "root.child.creditCheck.CheckingCreditScores",
--   "root.child.creditCheck.CheckingCreditScores.CheckingEquiGavin",
--   "root.child.creditCheck.CheckingCreditScores.CheckingEquiGavin.CheckingForExistingReport",
--   "root.child.creditCheck.CheckingCreditScores.CheckingGavUnion",
--   "root.child.creditCheck.CheckingCreditScores.CheckingGavUnion.CheckingForExistingReport",
--   "root.child.creditCheck.CheckingCreditScores.CheckingGavperian",
--   "root.child.creditCheck.CheckingCreditScores.CheckingGavperian.CheckingForExistingReport"
-- ] 


SELECT jsonb_all_paths('{
  "creditCheck": {
    "CheckingCreditScores": "root"
  }
}'::jsonb,'root');


-- TODO: decide if this is the desired behavior
-- edge case: when prefix is NULL 
SELECT jsonb_all_paths('{
  "creditCheck": {
    "CheckingCreditScores": "root"
  }
}'::jsonb,NULL);
-- output: {NULL,NULL}

-- edge case: empty object input
SELECT jsonb_all_paths('{}'::jsonb,'');
SELECT jsonb_all_paths('{}'::jsonb,'root');
SELECT jsonb_all_paths('{}'::jsonb, 'machine');
-- output: [] or {}

-- edge case: NULL input
SELECT jsonb_all_paths(NULL,'');
-- output: [] or {}
SELECT jsonb_all_paths(NULL,'abcd');
SELECT jsonb_all_paths('"abcde"'::jsonb,'abcd');
SELECT jsonb_all_paths('"abcde"'::jsonb,'');
-- output: {NULL}

-- positive test case: with real example
SELECT jsonb_all_paths('{
  "creditCheck": {
    "CheckingCreditScores": {
      "CheckingEquiGavin": "CheckingForExistingReport",
      "CheckingGavUnion": "CheckingForExistingReport",
      "CheckingGavperian": "CheckingForExistingReport"
    }
  }
}'::jsonb,'machine');
-- output:
-- [
--   "machine.creditCheck",
--   "machine.creditCheck.CheckingCreditScores",
--   "machine.creditCheck.CheckingCreditScores.CheckingEquiGavin",
--   "machine.creditCheck.CheckingCreditScores.CheckingEquiGavin.CheckingForExistingReport",
--   "machine.creditCheck.CheckingCreditScores.CheckingGavUnion",
--   "machine.creditCheck.CheckingCreditScores.CheckingGavUnion.CheckingForExistingReport",
--   "machine.creditCheck.CheckingCreditScores.CheckingGavperian",
--   "machine.creditCheck.CheckingCreditScores.CheckingGavperian.CheckingForExistingReport"
-- ]    



-- This function tests the round-trip conversion of a JSONB object to an array of paths and back to a JSONB object.
-- It takes a JSONB input, extracts all paths using jsonb_all_paths, reconstructs the JSONB object using build_nested_json_recursive,
-- and returns the original JSONB, the reconstructed JSONB, and the array of paths.
-- This is useful for verifying the correctness of the path extraction and reconstruction functions.

CREATE OR REPLACE FUNCTION test_jsonb_roundtrip(input_jsonb JSONB)
RETURNS TABLE(original JSONB, reconstructed JSONB, paths TEXT[]) AS $$
DECLARE
    extracted_paths TEXT[];
    rebuilt_jsonb JSONB;
BEGIN
    extracted_paths := jsonb_all_paths(input_jsonb, '');
    rebuilt_jsonb := build_nested_json_recursive(extracted_paths);
    RETURN QUERY SELECT input_jsonb, rebuilt_jsonb, extracted_paths;
END;
$$ LANGUAGE plpgsql;

-- Example usage:
-- SELECT * FROM test_jsonb_roundtrip('{
--   "creditCheck": {
--     "CheckingCreditScores": {
--       "CheckingEquiGavin": "CheckingForExistingReport",
--       "CheckingGavUnion": "CheckingForExistingReport",
--       "CheckingGavperian": "CheckingForExistingReport"
--     }
--   }
-- }'::jsonb);




-- NEW SECTION: Sanitization functions for text to LTREE and arrays of text to arrays of LTREE


CREATE OR REPLACE FUNCTION deprecated_sanitize_to_ltree(input_text TEXT)
RETURNS LTREE AS $$
DECLARE
    sanitized_text TEXT;
BEGIN
    -- Apply three-step sanitization process
    sanitized_text := REGEXP_REPLACE(
        REGEXP_REPLACE(
            REGEXP_REPLACE(
                COALESCE(input_text, ''), 
                '\\s', '_', 'g'
            ),
            '[#()]', '', 'g'
        ),
        '[^a-zA-Z0-9_\\.-]', '', 'g'
    );
    
    -- Return as LTREE, handle empty string case
    IF sanitized_text = '' THEN
        RETURN NULL;
    END IF;
    
    RETURN sanitized_text::ltree;
--    RETURN text2ltree(sanitized_text);
-- EXCEPTION
--     WHEN OTHERS THEN
--         -- If conversion to LTREE fails, return NULL
--         RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;


CREATE OR REPLACE FUNCTION remove_hashtag_from_text(input_text TEXT)
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
CREATE OR REPLACE FUNCTION sanitize_to_ltree(input_text TEXT)
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
SELECT sanitize_to_ltree('#text');
SELECT sanitize_to_ltree('#text ');

SELECT sanitize_to_ltree('text abcd');

SELECT sanitize_to_ltree('some#text with spaces()');

SELECT sanitize_to_ltree('[root.child.grandchild]');


-- This function takes an array of text inputs, sanitizes each element to conform to LTREE format using the sanitize_to_ltree function,
-- and returns an array of LTREE. If any element cannot be converted to LTREE, it is skipped.
-- If the input array is NULL, the function returns an empty LTREE array
CREATE OR REPLACE FUNCTION sanitize_text_array_to_ltree_array(input_array TEXT[])
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
    
    -- Process each element in the array using sanitize_to_ltree
    FOREACH element IN ARRAY input_array
    LOOP
        sanitized_ltree := sanitize_to_ltree(element);
        
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
select sanitize_text_array_to_ltree_array(ARRAY['abcd #text','(machine)']);

-- negative test case: Empty Array input
-- select sanitize_text_array_to_ltree_array(ARRAY[]);
-- output: HINT: Explicitly cast to the desired type, for example ARRAY[]::integer[]

-- This function takes an array of text inputs, sanitizes each element to conform to LTREE format using the sanitize_to_ltree function,
-- and returns an array of TEXT. If any element cannot be converted to LTREE, it is skipped.
-- If the input array is NULL, the function returns an empty TEXT array
CREATE OR REPLACE FUNCTION sanitize_text_array_to_ltree_text_array(input_array TEXT[])
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
    
    -- Process each element in the array using sanitize_to_ltree
    FOREACH element IN ARRAY input_array
    LOOP
        sanitized_ltree := sanitize_to_ltree(element);
        
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
select sanitize_text_array_to_ltree_text_array(ARRAY['abcd #text','(machine)']);

-- NEW section LCA 

-- TODO: NOTE: lca method of ltree extension does not work as expected.
-- https://www.postgresql.org/message-id/29778.1531522452%40sss.pgh.pa.us

SELECT lca(ARRAY['a'::ltree, 'a.b.c'::ltree, 'a.b.c.f'::ltree]);
-- lca of above should be 'a' but returns NULL

-- This function takes an array of LTREE paths and returns their lowest common ancestor (LCA) as an LTREE.
-- If the input array is empty or NULL, the function returns NULL.
-- If there is no common ancestor, the function returns NULL.
CREATE OR REPLACE FUNCTION sql_lca_from_array(paths ltree[]) RETURNS ltree AS $$
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
SELECT sql_lca_from_array(ARRAY['a'::ltree, 'a.b.c'::ltree, 'a.b.c.f'::ltree]);
-- output: 'a'

-- positive test case: common ancestor exists
SELECT sql_lca_from_array(ARRAY['a.b.c.d'::ltree, 'a.b.c.e'::ltree, 'a.b.c.f'::ltree]);
-- output: 'a.b.c'

-- negative test case: no common ancestor
SELECT sql_lca_from_array(ARRAY['a.b.c.d'::ltree, 'x.y.z'::ltree]);
-- output: NULL


-- This function computes the lowest common ancestor (LCA) for a given transition JSONB object.
-- The transition JSONB is expected to have 'source' and 'target' fields.
-- The function sanitizes the 'source' and 'target' values to LTREE format,
-- retrieves their corresponding computed_state_key_ltree from the fsm_states table,
-- and then calculates the LCA of these paths.
-- If the LCA calculation returns NULL, it falls back to the root label of the source path.
-- If the source or target paths are invalid or not found, the function returns NULL.
-- Assumes the existence of the following:
-- 1. A table named fsm_states with columns computed_state_id_ltree (LTREE) and computed_state_key_ltree (LTREE).
-- 2. The sanitize_to_ltree function to sanitize text to LTREE.
-- 3. The sanitize_text_array_to_ltree_array function to sanitize an array of text to an array of LTREE.
-- 4. The sql_lca_from_array function to compute the LCA from an array of LTREE paths.
CREATE OR REPLACE FUNCTION sql_lca_for_transition(transition JSONB) RETURNS ltree AS $$
DECLARE
  source TEXT;
  sanitized_source LTREE;
  sanitized_source_ltree LTREE;
  target_array TEXT[];
  sanitized_target_array LTREE[];
  sanitized_target_ltree_array LTREE[];
  transition_domain_lca LTREE;
BEGIN
  -- Clean source
  source := transition->>'source';
  sanitized_source := sanitize_to_ltree(source);
  SELECT computed_state_key_ltree INTO sanitized_source_ltree
  FROM fsm_states
  WHERE computed_state_id_ltree = sanitized_source;

  RAISE NOTICE 'sanitized_source_ltree: %', sanitized_source_ltree;
  IF sanitized_source_ltree IS NULL THEN
    RETURN NULL;
  END IF;

   SELECT ARRAY(
          SELECT jsonb_array_elements_text(transition->'target')
  ) INTO target_array;

  RAISE NOTICE 'target_array: %', target_array;
  -- Sanitize target array
  IF target_array IS NULL THEN
      sanitized_target_array := ARRAY[]::ltree[];
  ELSE
      sanitized_target_array := sanitize_text_array_to_ltree_array(target_array);
  END IF;


  SELECT ARRAY(
          SELECT computed_state_key_ltree
          FROM fsm_states
          WHERE computed_state_id_ltree = ANY(sanitized_target_array)
  ) INTO sanitized_target_ltree_array;

  RAISE NOTICE 'sanitized_target_array: %', sanitized_target_ltree_array;


  -- Use already sanitized target array in transition_domain_lca
  transition_domain_lca := sql_lca_from_array(
      ARRAY[sanitized_source_ltree::ltree] || sanitized_target_ltree_array
  );

  RAISE NOTICE 'transition_domain_lca: %', transition_domain_lca;
  -- If LCA calculation returned NULL, fall back to the root label of source (first path element)
  IF transition_domain_lca IS NULL THEN
    BEGIN
      -- subpath(...,0,1) returns the root/top-most label of the ltree
      transition_domain_lca := subpath(sanitized_source_ltree, 0, 1);
    EXCEPTION WHEN OTHERS THEN
      -- leave as NULL if source isn't a valid ltree
      RAISE NOTICE 'Error in fallback transition_domain_lca calculation: %', SQLERRM;
      transition_domain_lca := NULL;
    END;
  END IF;

  RETURN transition_domain_lca;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;


-- Returns all proper ancestors of state_path_ltree, stopping before to_state_path_ltree (exclusive).
-- Assumes both inputs are already ltree type.
-- hint: from child to parent until to_state_path_ltree
CREATE OR REPLACE FUNCTION get_proper_ancestors_ltree(
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
CREATE OR REPLACE FUNCTION get_proper_ancestors(
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

