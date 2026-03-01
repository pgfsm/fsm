

-- This function computes the lowest common ancestor (LCA) for a given transition JSONB object.
-- The transition JSONB is expected to have 'source' and 'target' fields.
-- The function sanitizes the 'source' and 'target' values to LTREE format,
-- retrieves their corresponding computed_state_key_ltree from the fsm_states table,
-- and then calculates the LCA of these paths.
-- If the LCA calculation returns NULL, it falls back to the root label of the source path.
-- If the source or target paths are invalid or not found, the function returns NULL.
-- Assumes the existence of the following:
-- 1. A table named fsm_states with columns computed_state_id_ltree (LTREE) and computed_state_key_ltree (LTREE).
-- 2. The fsm_core.sanitize_text_to_ltree function to sanitize text to LTREE.
-- 3. The sanitize_text_array_to_ltree_array function to sanitize an array of text to an array of LTREE.
-- 4. The sql_lca_from_array function to compute the LCA from an array of LTREE paths.
CREATE OR REPLACE FUNCTION fsm_core.sql_lca_for_transition(transition JSONB) RETURNS ltree AS $$
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
  sanitized_source := fsm_core.sanitize_text_to_ltree(source);
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
      sanitized_target_array := fsm_core.sanitize_text_array_to_ltree_array(target_array);
  END IF;


  SELECT ARRAY(
          SELECT computed_state_key_ltree
          FROM fsm_states
          WHERE computed_state_id_ltree = ANY(sanitized_target_array)
  ) INTO sanitized_target_ltree_array;

  RAISE NOTICE 'sanitized_target_array: %', sanitized_target_ltree_array;


  -- Use already sanitized target array in transition_domain_lca
  transition_domain_lca := fsm_core.sql_lca_from_array(
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

