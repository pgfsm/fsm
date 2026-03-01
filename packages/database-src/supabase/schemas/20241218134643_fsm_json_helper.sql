
-- Helper functions for FSM implementation in PostgreSQL

-- this fsm_core.path_string_to_jsonb function converts a dot-separated path string into a nested JSONB object
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
CREATE OR REPLACE FUNCTION fsm_core.path_string_to_jsonb(path TEXT)
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
    RETURN jsonb_build_object(parts[1], fsm_core.path_string_to_jsonb(array_to_string(parts[2:], '.')));
  END IF;
END;
$$ LANGUAGE plpgsql;

-- example usage:
-- positive test case
SELECT fsm_core.path_string_to_jsonb('machine.creditCheck.Entering Information.CheckingCreditScores.CheckingEquiGavin');
-- output: {"machine": {"creditCheck": {"Entering Information": {"CheckingCreditScores": "CheckingEquiGavin"}}}}

-- edge case: empty string input
SELECT fsm_core.path_string_to_jsonb('');
-- output: {}

-- negative test case: NULL input
SELECT fsm_core.path_string_to_jsonb(NULL);
-- output: {}

-- edge case: single segment path
SELECT fsm_core.path_string_to_jsonb('root');
-- output: {"root": null}


-- This function deeply merges two JSONB objects.
-- If one value is an object and the other is a scalar, it adds the scalar as a key with a null value.
-- Example:
-- SELECT fsm_core.jsonb_deep_merge(
--   '{"a": {"b": "value1"}}'::jsonb,
--   '{"a": "value2", "c": {"d": "value3"}}'::jsonb
-- );
CREATE OR REPLACE FUNCTION fsm_core.jsonb_deep_merge(a jsonb, b jsonb)
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
                        fsm_core.jsonb_deep_merge(aval, jsonb_build_object(scalar_key, NULL)),
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
                        fsm_core.jsonb_deep_merge(jsonb_build_object(scalar_key, NULL), bval),
                        true
                    );
                ELSE
                    merged := jsonb_set(
                        merged,
                        ARRAY[key_],
                        fsm_core.jsonb_deep_merge(aval, bval),
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
SELECT fsm_core.jsonb_deep_merge(
  '{"a": "value1"}'::jsonb,
  '{"a": "value2"}'::jsonb
);
-- output: {"a": "value2"}

-- merging object with different keys
-- hint : a as parrallel state in state machine
SELECT fsm_core.jsonb_deep_merge(
  '{"a": {"b": "value1"}}'::jsonb,
  '{"a": {"c": "value2"}}'::jsonb
);
-- output: {"a": {"b": "value1", "c": "value2"}}

-- merging object and scalar: adds scalar as key with null value
SELECT fsm_core.jsonb_deep_merge(
  '{"a": {"b": "value1"}}'::jsonb,
  '{"a": "value2", "c": {"d": "value3"}}'::jsonb
);
-- output: {"a": {"b": "value1", "value2": null}, "c": {"d": "value3"}}

-- edge case: merging with NULL
SELECT fsm_core.jsonb_deep_merge(
  '{"a": "value2"}'::jsonb,
  NULL
);
-- output: {"a": "value2"}

-- edge case: merging NULL with NULL
SELECT fsm_core.jsonb_deep_merge(
  NULL,
  NULL
);
-- output: NULL

-- edge case: merging with empty object
SELECT fsm_core.jsonb_deep_merge(
  '{"a": "value2"}'::jsonb,
  '{}'::jsonb
);
-- output: {"a": "value2"}

-- edge case: merging empty object with empty object
SELECT fsm_core.jsonb_deep_merge(
  '{}'::jsonb,
  '{}'::jsonb
);
-- output: {}

-- edge case: merging empty object with NULL
SELECT fsm_core.jsonb_deep_merge(
  '{}'::jsonb,
  NULL
);
-- output: {}

-- edge case: merging object with non-object (scalar)
-- TODO: decide if this is the desired behavior or if we should return the object instead
-- or raise an error when scalar is passed as second argument
SELECT fsm_core.jsonb_deep_merge(
  '{"a": "value2"}'::jsonb,
  '"just a string"'::jsonb
);
-- output: "just a string"


SELECT fsm_core.jsonb_deep_merge(
  '"just a string"'::jsonb,
  '{"a": "value2"}'::jsonb
);
-- output: {"a": "value2"}


-- This function takes an array of dot-separated path strings and builds a single nested JSONB object.
-- It uses the fsm_core.path_string_to_jsonb function to convert each path string into a nested JSONB object,
-- and then merges them together using the fsm_core.jsonb_deep_merge function.
-- useful to build a nested jsonb  object from an array of paths.
-- array paths are stored as column in the fsm_states table.
CREATE OR REPLACE FUNCTION fsm_core.build_nested_json_recursive(paths TEXT[])
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
    result := fsm_core.jsonb_deep_merge(result, fsm_core.path_string_to_jsonb(path));
  END LOOP;

  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Example usage:
-- positive test case
SELECT fsm_core.build_nested_json_recursive(ARRAY[
  'machine',
  'machine.creditCheck',
  'machine.creditCheck.Entering Information',
  'machine.creditCheck.Entering Information.CheckingCreditScores',
  'machine.creditCheck.Entering Information.CheckingCreditScores.CheckingEquiGavin'
]);
-- output: {"machine": {"creditCheck": {"Entering Information": {"CheckingCreditScores": {"CheckingEquiGavin": null}}}}}

-- simple test case with single path
SELECT fsm_core.build_nested_json_recursive(ARRAY[
  'machine'
]);
-- output: {"machine": null}

-- test case with overlapping paths
SELECT fsm_core.build_nested_json_recursive(ARRAY[
  'machine',
  'machine.creditCheck',
  'machine.creditCheck.Entering Information',
  'machine.creditCheck.CheckingCreditScores'
]);
-- output: {"machine": {"creditCheck": "CheckingCreditScores"}}

-- test case with real example
SELECT fsm_core.build_nested_json_recursive(ARRAY[
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
SELECT fsm_core.build_nested_json_recursive(ARRAY[
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
SELECT fsm_core.build_nested_json_recursive(ARRAY[
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
-- SELECT fsm_core.build_nested_json_recursive(ARRAY[]);
-- output: HINT: Explicitly cast to the desired type, for example ARRAY[]::integer[].

-- negative case: NULL input
SELECT fsm_core.build_nested_json_recursive(ARRAY['machine', NULL]);
-- output: {"machine": null}
SELECT fsm_core.build_nested_json_recursive(ARRAY['', NULL]);
-- output: {}
SELECT fsm_core.build_nested_json_recursive(ARRAY['', '']);
-- output: {}
-- SELECT fsm_core.build_nested_json_recursive(NULL);
-- output: error: FOREACH expression must not be null
-- CONTEXT: PL/pgSQL function fsm_core.build_nested_json_recursive(text[]) line 6 at FOREACH over array



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


CREATE OR REPLACE FUNCTION fsm_core.jsonb_all_paths(j jsonb, prefix text DEFAULT '')
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
              result := result || fsm_core.jsonb_all_paths(rec.value, new_prefix);
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
SELECT fsm_core.jsonb_all_paths('{
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


SELECT fsm_core.jsonb_all_paths('{
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


SELECT fsm_core.jsonb_all_paths('{
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


SELECT fsm_core.jsonb_all_paths('{
  "creditCheck": {
    "CheckingCreditScores": "root"
  }
}'::jsonb,'root');


-- TODO: decide if this is the desired behavior
-- edge case: when prefix is NULL 
SELECT fsm_core.jsonb_all_paths('{
  "creditCheck": {
    "CheckingCreditScores": "root"
  }
}'::jsonb,NULL);
-- output: {NULL,NULL}

-- edge case: empty object input
SELECT fsm_core.jsonb_all_paths('{}'::jsonb,'');
SELECT fsm_core.jsonb_all_paths('{}'::jsonb,'root');
SELECT fsm_core.jsonb_all_paths('{}'::jsonb, 'machine');
-- output: [] or {}

-- edge case: NULL input
SELECT fsm_core.jsonb_all_paths(NULL,'');
-- output: [] or {}
SELECT fsm_core.jsonb_all_paths(NULL,'abcd');
SELECT fsm_core.jsonb_all_paths('"abcde"'::jsonb,'abcd');
SELECT fsm_core.jsonb_all_paths('"abcde"'::jsonb,'');
-- output: {NULL}

-- positive test case: with real example
SELECT fsm_core.jsonb_all_paths('{
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
-- It takes a JSONB input, extracts all paths using fsm_core.jsonb_all_paths, reconstructs the JSONB object using fsm_core.build_nested_json_recursive,
-- and returns the original JSONB, the reconstructed JSONB, and the array of paths.
-- This is useful for verifying the correctness of the path extraction and reconstruction functions.

CREATE OR REPLACE FUNCTION fsm_core.test_jsonb_roundtrip(input_jsonb JSONB)
RETURNS TABLE(original JSONB, reconstructed JSONB, paths TEXT[]) AS $$
DECLARE
    extracted_paths TEXT[];
    rebuilt_jsonb JSONB;
BEGIN
    extracted_paths := fsm_core.jsonb_all_paths(input_jsonb, '');
    rebuilt_jsonb := fsm_core.build_nested_json_recursive(extracted_paths);
    RETURN QUERY SELECT input_jsonb, rebuilt_jsonb, extracted_paths;
END;
$$ LANGUAGE plpgsql;

-- Example usage:
-- SELECT * FROM fsm_core.test_jsonb_roundtrip('{
--   "creditCheck": {
--     "CheckingCreditScores": {
--       "CheckingEquiGavin": "CheckingForExistingReport",
--       "CheckingGavUnion": "CheckingForExistingReport",
--       "CheckingGavperian": "CheckingForExistingReport"
--     }
--   }
-- }'::jsonb);


