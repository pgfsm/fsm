set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.build_nested_json_recursive(paths text[])
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.deprecated_sanitize_to_ltree(input_text text)
 RETURNS ltree
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.get_proper_ancestors(state_path_ltree text, to_state_path_ltree text)
 RETURNS text[]
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.get_proper_ancestors_ltree(state_path_ltree ltree, to_state_path_ltree ltree)
 RETURNS ltree[]
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.jsonb_all_paths(j jsonb, prefix text DEFAULT ''::text)
 RETURNS text[]
 LANGUAGE plpgsql
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.jsonb_deep_merge(a jsonb, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.path_string_to_jsonb(path text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.path_to_jsonb(parts text[])
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.remove_hashtag_from_text(input_text text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.sanitize_text_array_to_ltree_array(input_array text[])
 RETURNS ltree[]
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.sanitize_text_array_to_ltree_text_array(input_array text[])
 RETURNS text[]
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.sanitize_to_ltree(input_text text)
 RETURNS ltree
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.sql_lca_for_transition(transition jsonb)
 RETURNS ltree
 LANGUAGE plpgsql
 IMMUTABLE STRICT
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.sql_lca_from_array(paths ltree[])
 RETURNS ltree
 LANGUAGE sql
 IMMUTABLE STRICT
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.test_jsonb_roundtrip(input_jsonb jsonb)
 RETURNS TABLE(original jsonb, reconstructed jsonb, paths text[])
 LANGUAGE plpgsql
AS $function$
DECLARE
    extracted_paths TEXT[];
    rebuilt_jsonb JSONB;
BEGIN
    extracted_paths := jsonb_all_paths(input_jsonb, '');
    rebuilt_jsonb := build_nested_json_recursive(extracted_paths);
    RETURN QUERY SELECT input_jsonb, rebuilt_jsonb, extracted_paths;
END;
$function$
;


