set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.compute_child_exit_set_v1(transition_domain_lca ltree, state_node_set ltree[])
 RETURNS text[]
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
  st ltree;
  result TEXT[] := ARRAY[]::TEXT[];
BEGIN
  
  FOREACH st IN ARRAY state_node_set LOOP
    -- use ltree descendant operator: left <@ right (st <@ domain) means st is contained by domain
    IF st <@ transition_domain_lca THEN
      result := result || st::text;
    END IF;
  END LOOP;

  RETURN result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.compute_exit_actions_v1(transition_record fsm_core.fsm_transitions, p_state_node_set text[], p_fsm_name text, p_fsm_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  exit_set_result TEXT[];
  actions_result JSONB;
BEGIN

  
  -- If no transition found, return empty array
  IF transition_record IS NULL THEN
      RETURN jsonb_build_object(
              'exit_nodes', '[]'::JSONB,
              'exit_actions', '[]'::JSONB
            );
  END IF;



  RAISE NOTICE 'Transition Record: %', transition_record;
  -- Step 1: Call compute_full_exit_set function
  SELECT fsm_core.compute_full_exit_set_v1(transition_record, p_state_node_set) INTO exit_set_result;

  RAISE NOTICE 'Exit Set Result: %', exit_set_result;

  -- Step 2: Call fsm_core.get_exit_actions_v1 with the result from step 1
  SELECT fsm_core.get_exit_actions_v1(exit_set_result, p_fsm_name, p_fsm_version) INTO actions_result;

  RAISE NOTICE 'exit_actions Result: %', actions_result;

  -- Return both exit_nodes and exit_actions as a JSON object
  RETURN jsonb_build_object(
    'exit_nodes', exit_set_result,
    'exit_actions', actions_result->'actions'
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.compute_full_exit_set_v1(transition_record fsm_core.fsm_transitions, state_node_set text[])
 RETURNS text[]
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
  transition_domain_lca ltree;
  state_node_set_ltree ltree[];
  sanitized_source TEXT;
  exit_set TEXT[] := ARRAY[]::TEXT[];
  child_exit TEXT[] := ARRAY[]::TEXT[];
  combined TEXT[];
BEGIN
  IF transition_record IS NULL OR state_node_set IS NULL THEN
    RETURN ARRAY[]::TEXT[];
  END IF;

  
  RAISE NOTICE 'Calculating Transition Domain LCA from transition_record: %', transition_record;


  transition_domain_lca := fsm_core.sql_lca_from_array(
      ARRAY[transition_record.computed_sanitized_source_ltree::ltree] || transition_record.computed_sanitized_target_ltree_array
  );


  state_node_set_ltree = fsm_core.sanitize_text_array_to_ltree_array(state_node_set);
  -- call child exit set using the domain text (fsm_core.compute_child_exit_set_v1 will sanitize)
  child_exit := fsm_core.compute_child_exit_set_v1(transition_domain_lca, state_node_set_ltree);

  -- sanitize source to compare with LCA in the same normalized form
  sanitized_source := transition_record.computed_sanitized_source_ltree;

  IF sanitized_source IS NOT NULL AND sanitized_source <> '' THEN
    IF transition_domain_lca IS NOT NULL THEN
      IF transition_domain_lca::TEXT = sanitized_source::TEXT THEN
        -- Only add the source_text when the transition JSON has a truthy
        -- "reenter" flag. Use COALESCE to safely cast NULL to false.
        IF COALESCE(transition_record.reenter, 'false')::boolean = true THEN
          exit_set := exit_set || sanitized_source;
        END IF;
      END IF;
    END IF;
  END IF;

  -- combine and deduplicate
  combined := exit_set || child_exit;
  SELECT array_agg(DISTINCT x) INTO combined FROM unnest(combined) AS x WHERE x IS NOT NULL;

  RETURN COALESCE(combined, ARRAY[]::TEXT[]);
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.get_exit_actions_v1(p_state_paths text[], p_fsm_name text, p_fsm_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
    all_actions JSONB := '[]'::jsonb;
    rec RECORD;
    action JSONB;
    i INTEGER;
BEGIN
    -- Collect all actions from matching records
    
    FOR rec IN
        SELECT 
            COALESCE(fs.exit, '[]'::jsonb) AS exit_actions,
            COALESCE(fs.invoke, '[]'::jsonb) AS invoke_actions,
            fs.fsm_order
        FROM fsm_core.fsm_states fs
        WHERE 
            -- p_state_paths should be always matched from computed_state_key_ltree column
            fs.computed_state_key_ltree = ANY(p_state_paths::ltree[])
            AND fs.fsm_name = p_fsm_name
            AND fs.fsm_version = p_fsm_version
        ORDER BY fs.fsm_order DESC
    LOOP
        -- Process exit actions and add to combined array
        IF jsonb_array_length(rec.exit_actions) > 0 THEN
            FOR i IN 0..jsonb_array_length(rec.exit_actions)-1 LOOP
                action := rec.exit_actions->i;
                action := action || jsonb_build_object(
                    'fsm_order', rec.fsm_order,
                    'action_type', 'exit'
                );
                all_actions := all_actions || jsonb_build_array(action);
            END LOOP;
        END IF;
        
        -- Process invoke actions and add to combined array
        IF jsonb_array_length(rec.invoke_actions) > 0 THEN
            FOR i IN 0..jsonb_array_length(rec.invoke_actions)-1 LOOP
                action := rec.invoke_actions->i;
                action := action || jsonb_build_object(
                    'fsm_order', rec.fsm_order,
                    'action_type', 'invoke'
                );
                all_actions := all_actions || jsonb_build_array(action);
            END LOOP;
        END IF;
    END LOOP;
    
    -- Return single JSON with combined actions array
    -- Actions are already sorted by fsm_order DESC due to the ORDER BY in the query
    RETURN jsonb_build_object('actions', all_actions);
END;
$function$
;


set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.test_event_transition_for_exit_v2(event_name text, p_state_node_set text[], fsm_name_param text, fsm_version_param text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    transition_record fsm_core.fsm_transitions;
    transition_json JSONB;
    result JSONB;
BEGIN
    -- Find single record from fsm_core.fsm_transitions based on event_type, fsm_name, and fsm_version
    SELECT * INTO transition_record
    FROM fsm_core.fsm_transitions 
    WHERE event_type = event_name 
      AND fsm_name = fsm_name_param 
      AND fsm_version = fsm_version_param
    LIMIT 1;


    SELECT fsm_core.compute_exit_actions_v1(transition_record, p_state_node_set, fsm_name_param, fsm_version_param) INTO result;


    RETURN result;
END;
$function$
;


