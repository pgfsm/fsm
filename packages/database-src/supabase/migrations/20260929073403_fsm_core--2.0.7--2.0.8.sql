-- Hand-added ahead of the diff output (SPEC-006, #421): the unique constraint
-- below fails on a database where concurrent loads already duplicated a
-- definition. Drop exact duplicates (same name, version and content), keeping
-- the oldest row, and refuse to continue if any name/version still has rows
-- with different content: which one is right is an operator's call.
DELETE FROM fsm_core.fsm_json a
USING fsm_core.fsm_json b
WHERE a.fsm_name = b.fsm_name
  AND a.fsm_version = b.fsm_version
  AND a.fsm_json = b.fsm_json
  AND a.id > b.id;

DO $$
DECLARE
    conflicts TEXT;
BEGIN
    SELECT string_agg(fsm_name || '/' || fsm_version, ', ')
    INTO conflicts
    FROM (
        SELECT fsm_name, fsm_version
        FROM fsm_core.fsm_json
        WHERE fsm_name IS NOT NULL AND fsm_version IS NOT NULL
        GROUP BY fsm_name, fsm_version
        HAVING count(*) > 1
    ) d;

    IF conflicts IS NOT NULL THEN
        RAISE EXCEPTION 'fsm_core.fsm_json has conflicting definitions for: %. Keep one row per name/version, then re-run this migration.', conflicts;
    END IF;
END $$;

CREATE UNIQUE INDEX fsm_json_fsm_name_fsm_version_key ON fsm_core.fsm_json USING btree (fsm_name, fsm_version);

alter table "fsm_core"."fsm_json" add constraint "fsm_json_fsm_name_fsm_version_key" UNIQUE using index "fsm_json_fsm_name_fsm_version_key";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.load_fsm_from_json_v2(json_input jsonb, root_node_text text, input_fsm_name text, input_fsm_version text, input_dependent_children jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    state_result JSONB;
    transition_result JSONB;
    state_ok BOOLEAN;
    transition_ok BOOLEAN;
    schema_json JSON;
    schema_errors TEXT[];
    existing_fsm_json JSONB;
BEGIN
    -- Serialize concurrent loads of the same name/version (SPEC-006): without
    -- it two callers can both miss the existence check below and both insert.
    -- Two-key form keeps this out of the single-bigint advisory key space.
    PERFORM pg_advisory_xact_lock(
        hashtext('fsm_core.load_fsm_from_json_v2'),
        hashtext(input_fsm_name || '.' || input_fsm_version)
    );

    SELECT fsm_json
    INTO existing_fsm_json
    FROM fsm_core.fsm_json
    WHERE fsm_name = input_fsm_name
      AND fsm_version = input_fsm_version
    LIMIT 1;

    IF existing_fsm_json IS NOT NULL THEN
        IF existing_fsm_json = json_input THEN
            RETURN jsonb_build_object(
                'ok', to_jsonb(true),
                'fsm_json', existing_fsm_json,
                'cached', to_jsonb(true)
            );
        ELSE
            RAISE EXCEPTION 'FSM % version % already loaded with different JSON content', input_fsm_name, input_fsm_version;
        END IF;
    END IF;

    -- SELECT config_value
    -- INTO schema_json
    -- FROM fsm_core.config_store
    -- WHERE config_name = 'fsm_schema'
    -- ORDER BY config_version DESC
    -- LIMIT 1;

    schema_json := fsm_core.fsm_json_schema();

    IF schema_json IS NULL THEN
        RAISE EXCEPTION 'Missing fsm_schema in fsm_core.config_store for % version %', input_fsm_name, input_fsm_version;
    END IF;

    schema_errors := fsm_core.jsonschema_validation_errors(schema_json, json_input::JSON);
    IF schema_errors IS NOT NULL AND array_length(schema_errors, 1) > 0 THEN
        RAISE NOTICE 'FSM schema validation errors for % version %: %', input_fsm_name, input_fsm_version, schema_errors;
        -- RAISE EXCEPTION 'json_input failed schema validation for % version %: %', input_fsm_name, input_fsm_version, schema_errors;
    END IF;

    state_result := fsm_core.load_fsm_state_from_json_v2(json_input := json_input, root_node_text := root_node_text, input_fsm_name := input_fsm_name, input_fsm_version := input_fsm_version);

    IF state_result IS NULL THEN
        RAISE EXCEPTION 'fsm_core.load_fsm_state_from_json_v2 returned NULL for % version %', input_fsm_name, input_fsm_version;
    END IF;

    state_ok := COALESCE((state_result->>'ok')::BOOLEAN, false);
    IF NOT state_ok THEN
        RAISE EXCEPTION 'fsm_core.load_fsm_state_from_json_v2 reported failure: %', state_result;
    END IF;

    transition_result := fsm_core.load_fsm_transition_from_json_v2(json_input := json_input, root_node_text := root_node_text, fsm_name := input_fsm_name, fsm_version := input_fsm_version);

    IF transition_result IS NULL THEN
        RAISE EXCEPTION 'fsm_core.load_fsm_transition_from_json_v2 returned NULL for % version %', input_fsm_name, input_fsm_version;
    END IF;

    transition_ok := COALESCE((transition_result->>'ok')::BOOLEAN, false);
    IF NOT transition_ok THEN
        RAISE EXCEPTION 'fsm_core.load_fsm_transition_from_json_v2 reported failure: %', transition_result;
    END IF;

    IF input_dependent_children IS NOT NULL
       AND jsonb_array_length(input_dependent_children) > 0 THEN
        PERFORM fsm_core.insert_fsm_dependencies(
            input_fsm_name, input_fsm_version, input_dependent_children
        );
    END IF;

    INSERT INTO fsm_core.fsm_json (fsm_name, fsm_version, fsm_json)
    VALUES (input_fsm_name, input_fsm_version, json_input);

    RETURN jsonb_build_object(
        'ok', to_jsonb(true),
        'cached', to_jsonb(false),
        'fsm_json', json_input,
        'state_result', state_result,
        'transition_result', transition_result
    );
END;
$function$
;


