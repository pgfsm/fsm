create sequence "fsm_core"."fsm_json_id_seq";

create table "fsm_core"."config_store" (
    "config_name" text,
    "config_value" json not null,
    "config_version" integer generated always as identity not null
);


create table "fsm_core"."fsm_json" (
    "id" integer not null default nextval('fsm_core.fsm_json_id_seq'::regclass),
    "fsm_name" text,
    "fsm_version" text,
    "fsm_json" json
);


alter sequence "fsm_core"."fsm_json_id_seq" owned by "fsm_core"."fsm_json"."id";

CREATE UNIQUE INDEX config_store_pkey ON fsm_core.config_store USING btree (config_version);

CREATE UNIQUE INDEX fsm_json_pkey ON fsm_core.fsm_json USING btree (id);

alter table "fsm_core"."config_store" add constraint "config_store_pkey" PRIMARY KEY using index "config_store_pkey";

alter table "fsm_core"."fsm_json" add constraint "fsm_json_pkey" PRIMARY KEY using index "fsm_json_pkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.load_fsm_from_json_v2(json_input jsonb, root_node_text text, input_fsm_name text, input_fsm_version text)
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
    existing_fsm_json JSON;
BEGIN
    SELECT fsm_json
    INTO existing_fsm_json
    FROM fsm_core.fsm_json
    WHERE fsm_name = input_fsm_name
      AND fsm_version = input_fsm_version
    LIMIT 1;

    IF existing_fsm_json IS NOT NULL THEN
        RETURN jsonb_build_object(
            'ok', to_jsonb(true),
            'fsm_json', to_jsonb(existing_fsm_json),
            'cached', to_jsonb(true)
        );
    END IF;

    SELECT config_value
    INTO schema_json
    FROM fsm_core.config_store
    WHERE config_name = 'fsm_schema'
    ORDER BY config_version DESC
    LIMIT 1;

    IF schema_json IS NULL THEN
        RAISE EXCEPTION 'Missing fsm_schema in fsm_core.config_store for % version %', input_fsm_name, input_fsm_version;
    END IF;

    schema_errors := jsonschema_validation_errors(schema_json, json_input::JSON);
    IF schema_errors IS NOT NULL AND array_length(schema_errors, 1) > 0 THEN
        RAISE NOTICE 'FSM schema validation errors for % version %: %', input_fsm_name, input_fsm_version, schema_errors;
        -- RAISE EXCEPTION 'json_input failed schema validation for % version %: %', input_fsm_name, input_fsm_version, schema_errors;
    END IF;

    state_result := fsm_core.load_fsm_state_from_json_v2(json_input, root_node_text, input_fsm_name, input_fsm_version);

    IF state_result IS NULL THEN
        RAISE EXCEPTION 'fsm_core.load_fsm_state_from_json_v2 returned NULL for % version %', input_fsm_name, input_fsm_version;
    END IF;

    state_ok := COALESCE((state_result->>'ok')::BOOLEAN, false);
    IF NOT state_ok THEN
        RAISE EXCEPTION 'fsm_core.load_fsm_state_from_json_v2 reported failure: %', state_result;
    END IF;

    transition_result := fsm_core.load_fsm_transition_from_json_v2(json_input, root_node_text, input_fsm_name, input_fsm_version);

    IF transition_result IS NULL THEN
        RAISE EXCEPTION 'fsm_core.load_fsm_transition_from_json_v2 returned NULL for % version %', input_fsm_name, input_fsm_version;
    END IF;

    transition_ok := COALESCE((transition_result->>'ok')::BOOLEAN, false);
    IF NOT transition_ok THEN
        RAISE EXCEPTION 'fsm_core.load_fsm_transition_from_json_v2 reported failure: %', transition_result;
    END IF;

    INSERT INTO fsm_core.fsm_json (fsm_name, fsm_version, fsm_json)
    VALUES (input_fsm_name, input_fsm_version, json_input::JSON);

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

grant delete on table "fsm_core"."config_store" to "anon";

grant insert on table "fsm_core"."config_store" to "anon";

grant references on table "fsm_core"."config_store" to "anon";

grant select on table "fsm_core"."config_store" to "anon";

grant trigger on table "fsm_core"."config_store" to "anon";

grant truncate on table "fsm_core"."config_store" to "anon";

grant update on table "fsm_core"."config_store" to "anon";

grant delete on table "fsm_core"."config_store" to "authenticated";

grant insert on table "fsm_core"."config_store" to "authenticated";

grant references on table "fsm_core"."config_store" to "authenticated";

grant select on table "fsm_core"."config_store" to "authenticated";

grant trigger on table "fsm_core"."config_store" to "authenticated";

grant truncate on table "fsm_core"."config_store" to "authenticated";

grant update on table "fsm_core"."config_store" to "authenticated";

grant delete on table "fsm_core"."config_store" to "service_role";

grant insert on table "fsm_core"."config_store" to "service_role";

grant references on table "fsm_core"."config_store" to "service_role";

grant select on table "fsm_core"."config_store" to "service_role";

grant trigger on table "fsm_core"."config_store" to "service_role";

grant truncate on table "fsm_core"."config_store" to "service_role";

grant update on table "fsm_core"."config_store" to "service_role";

grant delete on table "fsm_core"."fsm_json" to "anon";

grant insert on table "fsm_core"."fsm_json" to "anon";

grant references on table "fsm_core"."fsm_json" to "anon";

grant select on table "fsm_core"."fsm_json" to "anon";

grant trigger on table "fsm_core"."fsm_json" to "anon";

grant truncate on table "fsm_core"."fsm_json" to "anon";

grant update on table "fsm_core"."fsm_json" to "anon";

grant delete on table "fsm_core"."fsm_json" to "authenticated";

grant insert on table "fsm_core"."fsm_json" to "authenticated";

grant references on table "fsm_core"."fsm_json" to "authenticated";

grant select on table "fsm_core"."fsm_json" to "authenticated";

grant trigger on table "fsm_core"."fsm_json" to "authenticated";

grant truncate on table "fsm_core"."fsm_json" to "authenticated";

grant update on table "fsm_core"."fsm_json" to "authenticated";

grant delete on table "fsm_core"."fsm_json" to "service_role";

grant insert on table "fsm_core"."fsm_json" to "service_role";

grant references on table "fsm_core"."fsm_json" to "service_role";

grant select on table "fsm_core"."fsm_json" to "service_role";

grant trigger on table "fsm_core"."fsm_json" to "service_role";

grant truncate on table "fsm_core"."fsm_json" to "service_role";

grant update on table "fsm_core"."fsm_json" to "service_role";


