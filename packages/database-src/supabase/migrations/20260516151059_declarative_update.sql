drop function if exists "fsm_core"."archive_event_from_fsm_promise_type_worker_v2"(promise_queue_name text, queue_msg_id bigint, send_to_parent_queue_id uuid, send_event_name_to_parent_queue_id text, event_output jsonb, event_status text, event_duration integer, event_finished_at timestamp with time zone);

drop function if exists "fsm_core"."load_fsm_from_json_v2"(json_input jsonb, root_node_text text, input_fsm_name text, input_fsm_version text);

drop function if exists "fsm_core"."send_event_to_fsm_promise_queue_from_fsm_instance_id_v2"(event_name text, event_input jsonb, promise_queue_name text, from_source_fsm_instance_id uuid);

drop function if exists "fsm_core"."send_event_to_queue_with_event_logs_v2"(input_msg jsonb, input_event_source jsonb, input_event_name text, input_event_delay integer, input_fsm_instance_id uuid);

alter table "fsm_core"."fsm_instance_queue_event_logs" drop constraint "fsm_instance_queue_event_logs_pkey";

alter table "fsm_core"."fsm_promise_queue_event_logs" drop constraint "fsm_promise_queue_event_logs_pkey";

drop index if exists "fsm_core"."fsm_instance_queue_event_logs_pkey";

drop index if exists "fsm_core"."fsm_promise_queue_event_logs_pkey";

alter table "fsm_core"."fsm_instance_queue_event_logs" drop column "event_duration";

alter table "fsm_core"."fsm_instance_queue_event_logs" drop column "event_finished_at";

alter table "fsm_core"."fsm_instance_queue_event_logs" drop column "event_source";

alter table "fsm_core"."fsm_instance_queue_event_logs" drop column "event_started_at";

alter table "fsm_core"."fsm_instance_queue_event_logs" drop column "id";

alter table "fsm_core"."fsm_instance_queue_event_logs" add column "event_delay" integer;

alter table "fsm_core"."fsm_instance_queue_event_logs" add column "execution_duration" integer;

alter table "fsm_core"."fsm_instance_queue_event_logs" add column "execution_finished_at" timestamp with time zone default now();

alter table "fsm_core"."fsm_instance_queue_event_logs" add column "execution_started_at" timestamp with time zone default now();

alter table "fsm_core"."fsm_instance_queue_event_logs" add column "fsm_instance_id_fsm_type" text;

alter table "fsm_core"."fsm_instance_queue_event_logs" add column "fsm_instance_id_fsm_version" text;

alter table "fsm_core"."fsm_instance_queue_event_logs" add column "fsm_instance_queue_event_log_id" uuid not null default gen_random_uuid();

alter table "fsm_core"."fsm_instance_queue_event_logs" add column "send_to_parent_queue_id" uuid;

alter table "fsm_core"."fsm_instance_queue_event_logs" add column "send_to_parent_queue_id_event_name" text;

alter table "fsm_core"."fsm_json" add column "fsm_type" text;

alter table "fsm_core"."fsm_promise_queue_event_logs" drop column "event_duration";

alter table "fsm_core"."fsm_promise_queue_event_logs" drop column "event_finished_at";

alter table "fsm_core"."fsm_promise_queue_event_logs" drop column "event_input";

alter table "fsm_core"."fsm_promise_queue_event_logs" drop column "event_started_at";

alter table "fsm_core"."fsm_promise_queue_event_logs" drop column "id";

alter table "fsm_core"."fsm_promise_queue_event_logs" drop column "send_to_parent_queue_id_msg_id";

alter table "fsm_core"."fsm_promise_queue_event_logs" add column "event_data" jsonb;

alter table "fsm_core"."fsm_promise_queue_event_logs" add column "event_delay" integer;

alter table "fsm_core"."fsm_promise_queue_event_logs" add column "execution_duration" integer;

alter table "fsm_core"."fsm_promise_queue_event_logs" add column "execution_finished_at" timestamp with time zone default now();

alter table "fsm_core"."fsm_promise_queue_event_logs" add column "execution_started_at" timestamp with time zone default now();

alter table "fsm_core"."fsm_promise_queue_event_logs" add column "promise_fn_name" text;

alter table "fsm_core"."fsm_promise_queue_event_logs" add column "promise_queue_event_log_id" uuid not null default gen_random_uuid();

alter table "fsm_core"."fsm_promise_queue_event_logs" add column "promise_queue_type" text;

alter table "fsm_core"."fsm_promise_queue_event_logs" add column "promise_queue_version" text;

alter table "fsm_core"."fsm_promise_queue_event_logs" add column "send_to_parent_queue_id_event_name" text;

CREATE UNIQUE INDEX fsm_instance_queue_event_logs_pkey ON fsm_core.fsm_instance_queue_event_logs USING btree (fsm_instance_queue_event_log_id);

CREATE UNIQUE INDEX fsm_promise_queue_event_logs_pkey ON fsm_core.fsm_promise_queue_event_logs USING btree (promise_queue_event_log_id);

alter table "fsm_core"."fsm_instance_queue_event_logs" add constraint "fsm_instance_queue_event_logs_pkey" PRIMARY KEY using index "fsm_instance_queue_event_logs_pkey";

alter table "fsm_core"."fsm_promise_queue_event_logs" add constraint "fsm_promise_queue_event_logs_pkey" PRIMARY KEY using index "fsm_promise_queue_event_logs_pkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.archive_event_from_fsm_promise_type_worker_v2(input_promise_queue_name text, input_promise_queue_type text, input_promise_queue_version text, input_promise_queue_msg_id bigint, input_event_name text, input_event_action_type text, input_event_data jsonb, input_event_delay integer, input_send_to_parent_queue_id uuid, input_send_to_parent_queue_id_event_name text, input_execution_started_at timestamp with time zone, input_execution_duration integer, input_execution_finished_at timestamp with time zone, input_event_status text, input_event_output jsonb, input_error_message text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    promise_archive_result boolean;
    send_to_parent_result jsonb;
    output_promise_queue_event_log_id uuid;
BEGIN
    -- 1. Remove event from promise queue
    promise_archive_result := pgmq.archive(
        queue_name := input_promise_queue_name,
        msg_id := input_promise_queue_msg_id
    );

    -- 2. Send promise result back to parent FSM queue
    send_to_parent_result := fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
        input_fsm_instance_id := input_send_to_parent_queue_id,
        input_fsm_instance_id_fsm_type := NULL,
        input_fsm_instance_id_fsm_version := NULL,
        input_send_to_parent_queue_id := NULL,
        input_send_to_parent_queue_type := NULL,
        input_send_to_parent_queue_id_event_name := NULL,
        input_event_name := input_event_name,
        input_event_action_type := 'promise_completed',
        input_event_data := input_event_output,
        input_event_delay := 0,
        input_event_status := input_event_status,
        input_event_output := input_event_output,
        input_error_message := input_error_message,
        input_execution_started_at := input_execution_started_at,
        input_execution_duration := input_execution_duration,
        input_execution_finished_at := input_execution_finished_at
    );

    -- 3. Log archive event in promise queue event logs
    INSERT INTO fsm_core.fsm_promise_queue_event_logs (
        promise_queue_name,
        promise_queue_type,
        promise_queue_version,
        promise_queue_msg_id,
        event_name,
        event_data,
        event_delay,
        send_to_parent_queue_id,
        send_to_parent_queue_id_event_name,
        execution_started_at,
        execution_duration,
        execution_finished_at,
        event_status,
        event_output,
        error_message
    ) VALUES (
        input_promise_queue_name,
        input_promise_queue_type,
        input_promise_queue_version,
        input_promise_queue_msg_id,
        input_event_name,
        input_event_data,
        input_event_delay,
        input_send_to_parent_queue_id,
        input_send_to_parent_queue_id_event_name,
        input_execution_started_at,
        input_execution_duration,
        input_execution_finished_at,
        input_event_status,
        input_event_output,
        input_error_message
    ) RETURNING promise_queue_event_log_id INTO output_promise_queue_event_log_id;

    RETURN jsonb_build_object(
        'promise_queue_archive_result', promise_archive_result,
        'promise_queue_name', input_promise_queue_name,
        'promise_queue_msg_id', input_promise_queue_msg_id,
        'send_to_parent_result', send_to_parent_result,
        'promise_queue_event_log_id', output_promise_queue_event_log_id
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.load_fsm_from_json_v2(json_input jsonb, root_node_text text, input_fsm_type text, input_fsm_name text, input_fsm_version text)
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

    INSERT INTO fsm_core.fsm_json (fsm_name, fsm_type, fsm_version, fsm_json)
    VALUES (input_fsm_name, input_fsm_type, input_fsm_version, json_input::JSON);

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

CREATE OR REPLACE FUNCTION fsm_core.send_event_to_fsm_queue_from_fsm_instance_id_v2(event_name text, event_input jsonb, id text, action_type text, src text, fsmname text, fsmtype text, fsmversion text, parentfsmname text, parentfsmversion text, from_source_fsm_instance_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    child_instance_id uuid := uuid_generate_v4();
    send_result jsonb;
BEGIN
    PERFORM pgmq.create(queue_name := child_instance_id::text);

    send_result := fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
        input_fsm_instance_id := child_instance_id,
        input_fsm_instance_id_fsm_type := fsmType,
        input_fsm_instance_id_fsm_version := fsmVersion,
        input_send_to_parent_queue_id := from_source_fsm_instance_id,
        input_send_to_parent_queue_type := fsmType,
        input_send_to_parent_queue_id_event_name := id,
        input_event_name := event_name,
        input_event_action_type := action_type,
        input_event_data := event_input,
        input_event_delay := 0,
        input_event_status := 'fsm_started',
        input_event_output := '{}'::jsonb,
        input_error_message := NULL
    );

    RETURN send_result || jsonb_build_object('start_queue_worker', true, 'child_instance_id', child_instance_id);
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.send_event_to_fsm_queue_with_event_logs_v2(input_fsm_instance_id uuid, input_fsm_instance_id_fsm_type text, input_fsm_instance_id_fsm_version text, input_send_to_parent_queue_id uuid, input_send_to_parent_queue_type text, input_send_to_parent_queue_id_event_name text, input_event_name text, input_event_action_type text, input_event_data jsonb, input_event_delay integer DEFAULT 0, input_event_status text DEFAULT 'ACTIVE'::text, input_event_output jsonb DEFAULT '{}'::jsonb, input_error_message text DEFAULT NULL::text, input_execution_started_at timestamp with time zone DEFAULT now(), input_execution_duration integer DEFAULT NULL::integer, input_execution_finished_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    queue_msg_data jsonb;
    output_fsm_instance_queue_msg_id bigint;
    output_fsm_instance_queue_event_log_id uuid;
BEGIN
    IF input_fsm_instance_id IS NULL THEN
        RAISE EXCEPTION 'fsm_instance_id is NULL';
    END IF;

    queue_msg_data := jsonb_build_object(
        
        'event_data', jsonb_build_object(
            'event_type', input_event_name,
            'event_payload', input_event_data,
            'action_type', input_event_action_type
        ),
        'queue_id', input_fsm_instance_id,
        'queue_type', input_fsm_instance_id_fsm_type,
        'queue_version', input_fsm_instance_id_fsm_version,
        'send_to_parent_queue_id', input_send_to_parent_queue_id,
        'send_to_parent_queue_type', input_send_to_parent_queue_type,
        'send_to_parent_queue_id_event_name', input_send_to_parent_queue_id_event_name
    );

    BEGIN
        SELECT pgmq.send(queue_name := input_fsm_instance_id::text, msg := queue_msg_data, delay := input_event_delay)
        INTO output_fsm_instance_queue_msg_id;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'pgmq.send failed for queue %: %', input_fsm_instance_id, SQLERRM;
    END;

    IF output_fsm_instance_queue_msg_id IS NULL THEN
        RAISE EXCEPTION 'Failed to send event to queue %', input_fsm_instance_id;
    END IF;

    -- Append queue_msg_id to queue_msg_data
    queue_msg_data := queue_msg_data || jsonb_build_object('queue_msg_id', output_fsm_instance_queue_msg_id);

    -- Append queue_msg_delay to queue_msg_data
    queue_msg_data := queue_msg_data || jsonb_build_object('queue_msg_delay', input_event_delay);

    INSERT INTO fsm_core.fsm_instance_queue_event_logs (
        fsm_instance_id,
        fsm_instance_id_fsm_type,
        fsm_instance_id_fsm_version,
        fsm_instance_queue_msg_id,
        event_name,
        event_data,
        event_delay,
        send_to_parent_queue_id,
        send_to_parent_queue_id_event_name,
        execution_started_at,
        execution_duration,
        execution_finished_at,
        event_status,
        event_output,
        error_message
    ) VALUES (
        input_fsm_instance_id,
        input_fsm_instance_id_fsm_type,
        input_fsm_instance_id_fsm_version,
        output_fsm_instance_queue_msg_id,
        input_event_name,
        input_event_data,
        input_event_delay,
        input_send_to_parent_queue_id,
        input_send_to_parent_queue_id_event_name,
        input_execution_started_at,
        input_execution_duration,
        input_execution_finished_at,
        input_event_status,
        input_event_output,
        input_error_message
    ) RETURNING fsm_instance_queue_event_log_id INTO output_fsm_instance_queue_event_log_id;

    RETURN jsonb_build_object(
     
        'queue_data', queue_msg_data,
        -- 'queue_msg_id', output_fsm_instance_queue_msg_id,
        -- 'queue_msg_delay', input_event_delay,
        'queue_event_log_id', output_fsm_instance_queue_event_log_id,
        'event_status', input_event_status,
        'event_output', input_event_output,
        'error_message', input_error_message
       
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.send_event_to_promise_queue_from_fsm_instance_id_v2(event_name text, event_input jsonb, id text, action_type text, src text, fsmname text, fsmtype text, fsmversion text, parentfsmname text, parentfsmversion text, from_source_fsm_instance_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    promise_queue_name text;
    queue_exists boolean := false;
    start_queue_worker boolean := false;
    send_result jsonb;
BEGIN
    IF fsmType = 'promise' THEN
        promise_queue_name := parentFsmName || '_' || parentFsmVersion || '_' || fsmName;
    ELSIF fsmType = 'sharedPromise' THEN
        promise_queue_name := 'sharedPromise_' || fsmName || '_' || fsmVersion;
    ELSE
        RAISE EXCEPTION 'send_event_to_promise_queue_from_fsm_instance_id_v2: unsupported fsmType: %', fsmType;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM pgmq.list_queues() WHERE queue_name = promise_queue_name
    ) INTO queue_exists;

    IF NOT queue_exists THEN
        PERFORM pgmq.create(queue_name := promise_queue_name);
        start_queue_worker := true;
    END IF;

    send_result := fsm_core.send_event_to_promise_queue_with_event_logs_v2(
        input_promise_queue_name := promise_queue_name,
        input_promise_fn_name := fsmName,
        input_promise_queue_type := fsmType,
        input_promise_queue_version := fsmVersion,
        input_send_to_parent_queue_id := from_source_fsm_instance_id,
        input_send_to_parent_queue_type := 'FSM',
        input_send_to_parent_queue_id_event_name := id,
        input_event_name := event_name,
        input_event_action_type := action_type,
        input_event_data := event_input,
        input_event_delay := 0,
        input_event_status := 'pomise_started',
        input_event_output := '{}'::jsonb,
        input_error_message := NULL
    );

    RETURN send_result || jsonb_build_object('start_queue_worker', start_queue_worker);
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.send_event_to_promise_queue_with_event_logs_v2(input_promise_queue_name text, input_promise_fn_name text, input_promise_queue_type text, input_promise_queue_version text, input_send_to_parent_queue_id uuid, input_send_to_parent_queue_type text, input_send_to_parent_queue_id_event_name text, input_event_name text, input_event_action_type text, input_event_data jsonb, input_event_delay integer DEFAULT 0, input_event_status text DEFAULT 'ACTIVE'::text, input_event_output jsonb DEFAULT '{}'::jsonb, input_error_message text DEFAULT NULL::text, input_execution_started_at timestamp with time zone DEFAULT now(), input_execution_duration integer DEFAULT NULL::integer, input_execution_finished_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    queue_msg_data jsonb;
    output_promise_queue_msg_id bigint;
    output_promise_queue_event_log_id uuid;
BEGIN
    IF input_promise_queue_name IS NULL THEN
        RAISE EXCEPTION 'promise_queue_name is NULL';
    END IF;

    queue_msg_data := jsonb_build_object(
        'event_data', jsonb_build_object(
            'event_type', input_event_name,
            'event_payload', input_event_data,
            'action_type', input_event_action_type
        ),
        'queue_id', input_promise_queue_name,
        'queue_fn_name', input_promise_fn_name,
        'queue_type', input_promise_queue_type,
        'queue_version', input_promise_queue_version,
        'send_to_parent_queue_id', input_send_to_parent_queue_id,
        'send_to_parent_queue_type', input_send_to_parent_queue_type,
        'send_to_parent_queue_id_event_name', input_send_to_parent_queue_id_event_name
    );

    BEGIN
        SELECT pgmq.send(queue_name := input_promise_queue_name, msg := queue_msg_data, delay := input_event_delay)
        INTO output_promise_queue_msg_id;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'pgmq.send failed for queue %: %', input_promise_queue_name, SQLERRM;
    END;

    IF output_promise_queue_msg_id IS NULL THEN
        RAISE EXCEPTION 'Failed to send event to queue %', input_promise_queue_name;
    END IF;

    -- Append queue_msg_id to queue_msg_data
    queue_msg_data := queue_msg_data || jsonb_build_object('queue_msg_id', output_promise_queue_msg_id);

    -- Append queue_msg_delay to queue_msg_data
    queue_msg_data := queue_msg_data || jsonb_build_object('queue_msg_delay', input_event_delay);


    INSERT INTO fsm_core.fsm_promise_queue_event_logs (
        promise_queue_name,
        promise_fn_name,
        promise_queue_type,
        promise_queue_version,
        promise_queue_msg_id,
        event_name,
        event_data,
        event_delay,
        send_to_parent_queue_id,
        send_to_parent_queue_id_event_name,
        execution_started_at,
        execution_duration,
        execution_finished_at,
        event_status,
        event_output,
        error_message
    ) VALUES (
        input_promise_queue_name,
        input_promise_fn_name,
        input_promise_queue_type,
        input_promise_queue_version,
        output_promise_queue_msg_id,
        input_event_name,
        input_event_data,
        input_event_delay,
        input_send_to_parent_queue_id,
        input_send_to_parent_queue_id_event_name,
        input_execution_started_at,
        input_execution_duration,
        input_execution_finished_at,
        input_event_status,
        input_event_output,
        input_error_message
    ) RETURNING promise_queue_event_log_id INTO output_promise_queue_event_log_id;

    
    RETURN jsonb_build_object(
        'queue_data', queue_msg_data,
        -- 'queue_msg_id', output_promise_queue_msg_id,
        -- 'queue_msg_delay', input_event_delay,
        'queue_event_log_id', output_promise_queue_event_log_id,
        'event_status', input_event_status,
        'event_output', input_event_output,
        'error_message', input_error_message
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.send_event_to_queue_from_fsm_instance_id_v2(event_name text, event_input jsonb, id text, action_type text, src text, fsmname text, fsmtype text, fsmversion text, parentfsmname text, parentfsmversion text, from_source_fsm_instance_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF fsmType = 'promise' OR fsmType = 'sharedPromise' THEN
        RETURN fsm_core.send_event_to_promise_queue_from_fsm_instance_id_v2(
            event_name := event_name,
            event_input := event_input,
            id := id,
            action_type := action_type,
            src := src,
            fsmName := fsmName,
            fsmType := fsmType,
            fsmVersion := fsmVersion,
            parentFsmName := parentFsmName,
            parentFsmVersion := parentFsmVersion,
            from_source_fsm_instance_id := from_source_fsm_instance_id
        );
    ELSIF fsmType = 'childFsm' THEN
        RETURN fsm_core.send_event_to_fsm_queue_from_fsm_instance_id_v2(
            event_name := event_name,
            event_input := event_input,
            id := id,
            action_type := action_type,
            src := src,
            fsmName := fsmName,
            fsmType := fsmType,
            fsmVersion := fsmVersion,
            parentFsmName := parentFsmName,
            parentFsmVersion := parentFsmVersion,
            from_source_fsm_instance_id := from_source_fsm_instance_id
        );
    ELSE
        RAISE EXCEPTION 'Unsupported fsmType: %', fsmType;
    END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.archive_event_from_fsm_type_worker_v2(remove_from_current_fsm_instance_queue_id text, remove_current_queue_msg_id bigint, to_be_removed_schedule_queue_msg_ids jsonb, to_be_removed_promise_queue_msg_ids jsonb, to_be_added_schedule_queue_data jsonb, to_be_added_promise_queue_data jsonb, input_total_schedule_queue_data jsonb, input_total_promise_queue_data jsonb, fsm_instance_data_save_fsm_status jsonb, fsm_instance_data_save_fsm_state jsonb, fsm_instance_data_save_fsm_context jsonb, fsm_instance_data_save_fsm_xstate_state jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    i int;
    
    schedule_queue_entry jsonb;
    remove_schedule boolean;
    schedule_queue_message jsonb;
    confirmed_removed_schedule_queue_data jsonb[] := '{}';
    confirmed_match_for_schedule boolean;
    not_confirmed_removed_schedule_queue_data jsonb[] := '{}';

    promise_queue_entry jsonb;
    remove_promise boolean;
    promise_queue_message jsonb;
    confirmed_removed_promise_queue_data jsonb[] := '{}';
    confirmed_match_for_promise boolean;
    not_confirmed_removed_promise_queue_data jsonb[] := '{}';
   
    to_be_added_schedule_queue_data_entry jsonb;
    to_be_added_schedule_queue_data_entry_delay int;
    output_schedule_result jsonb;
   
    to_be_added_promise_queue_data_entry jsonb;
    output_promise_result jsonb;

    new_total_schedule_queue_data jsonb := '[]'::jsonb;
    new_total_promise_queue_data jsonb := '[]'::jsonb;
    
    confirmed_removed_schedule_queue_data_success jsonb[] := '{}';
    confirmed_removed_schedule_queue_data_failed jsonb[] := '{}';

    confirmed_removed_promise_queue_data_success jsonb[] := '{}';
    confirmed_removed_promise_queue_data_failed jsonb[] := '{}';

    added_schedule_queue_data jsonb[] := '{}';
    added_promise_queue_data jsonb[] := '{}';
BEGIN
   

    -- 1.  Remove schedule queue messages
    -- A = 'input_total_schedule_queue_data'
    -- B = 'to_be_removed_schedule_queue_msg_ids'
    -- C = 'confirmed_removed_schedule_queue_data' (used for canceling events) ( C = A intersect B )
    -- D = 'not_confirmed_removed_schedule_queue_data' (used for returning to caller) ( D = B - C )
    IF input_total_schedule_queue_data IS NOT NULL THEN
        new_total_schedule_queue_data := '[]'::jsonb;
        FOR schedule_queue_entry IN
            SELECT value FROM jsonb_array_elements(input_total_schedule_queue_data) value
        LOOP
            remove_schedule := false;
            IF to_be_removed_schedule_queue_msg_ids IS NOT NULL THEN
                FOR i IN 0 .. jsonb_array_length(to_be_removed_schedule_queue_msg_ids)-1 LOOP
                    schedule_queue_message := to_be_removed_schedule_queue_msg_ids->i;
                   
                    IF (
                        (schedule_queue_entry->'event'->>'send_event_name_to_parent_queue_id')::text = (schedule_queue_message->>'id')::text
                        AND (schedule_queue_entry->>'schedule_queue_name')::text = (schedule_queue_message->>'src')::text
                    ) THEN
                        remove_schedule := true;
                        
                        EXIT;
                    END IF;
                END LOOP;
            END IF;

            IF remove_schedule THEN
                confirmed_removed_schedule_queue_data := array_append(confirmed_removed_schedule_queue_data, schedule_queue_entry);
            ELSE
                new_total_schedule_queue_data := array_append(new_total_schedule_queue_data, schedule_queue_entry);
            END IF;
        END LOOP;

       
    END IF;

    -- 1b. Derive not_confirmed_removed_schedule_queue_data
    -- D = B - C => not_confirmed_removed_schedule_queue_data = to_be_removed_schedule_queue_msg_ids - confirmed_removed_schedule_queue_data
    IF to_be_removed_schedule_queue_msg_ids IS NOT NULL THEN
        FOR i IN 0 .. jsonb_array_length(to_be_removed_schedule_queue_msg_ids)-1 LOOP
            schedule_queue_message := to_be_removed_schedule_queue_msg_ids->i;
            confirmed_match_for_schedule := false;
            FOREACH schedule_queue_entry IN ARRAY confirmed_removed_schedule_queue_data LOOP
                IF (
                    (schedule_queue_entry->>'id')::text = (schedule_queue_message->>'id')::text
                    AND (schedule_queue_entry->>'src')::text = (schedule_queue_message->>'src')::text
                ) THEN
                    confirmed_match_for_schedule := true;
                    EXIT;
                END IF;
            END LOOP;

            IF NOT confirmed_match_for_schedule THEN
                not_confirmed_removed_schedule_queue_data := array_append(not_confirmed_removed_schedule_queue_data, schedule_queue_message);
            END IF;
        END LOOP;
    END IF;


    -- 2. Cancel events for promise type workers and remove from input_total_promise_queue_data
    -- A = 'input_total_promise_queue_data'
    -- B = 'to_be_removed_promise_queue_msg_ids'
    -- C = 'confirmed_removed_promise_queue_data' (used for canceling events) ( C = A intersect B )
    -- D = 'not_confirmed_removed_promise_queue_data' (used for returning to caller) ( D = B - C )
    IF input_total_promise_queue_data IS NOT NULL THEN
        new_total_promise_queue_data := '[]'::jsonb;
        FOR promise_queue_entry IN
            SELECT value FROM jsonb_array_elements(input_total_promise_queue_data) value
        LOOP
            remove_promise := false;
            IF to_be_removed_promise_queue_msg_ids IS NOT NULL THEN
                FOR i IN 0 .. jsonb_array_length(to_be_removed_promise_queue_msg_ids)-1 LOOP
                    promise_queue_message := to_be_removed_promise_queue_msg_ids->i;
                    
                    IF (
                        (promise_queue_entry->>'send_to_parent_queue_id_event_name')::text = (promise_queue_message->>'id')::text
                        AND (promise_queue_entry->>'queue_fn_name')::text = (promise_queue_message->>'src')::text
                    ) THEN
                        remove_promise := true;
                        
                        EXIT;
                    END IF;
                END LOOP;
            END IF;

            IF remove_promise THEN
                confirmed_removed_promise_queue_data := array_append(confirmed_removed_promise_queue_data, promise_queue_entry);
            ELSE
                new_total_promise_queue_data := array_append(new_total_promise_queue_data, promise_queue_entry);
            END IF;
        END LOOP;

        
    END IF;

    -- 2b. Derive not_confirmed_removed_promise_queue_data
    -- D = B - C => not_confirmed_removed_promise_queue_data = to_be_removed_promise_queue_msg_ids - confirmed_removed_promise_queue_data
    IF to_be_removed_promise_queue_msg_ids IS NOT NULL THEN
        FOR i IN 0 .. jsonb_array_length(to_be_removed_promise_queue_msg_ids)-1 LOOP
            promise_queue_message := to_be_removed_promise_queue_msg_ids->i;
            confirmed_match_for_promise := false;
            FOREACH promise_queue_entry IN ARRAY confirmed_removed_promise_queue_data LOOP
                IF (
                    (promise_queue_entry->>'send_to_parent_queue_id_event_name')::text = (promise_queue_message->>'id')::text
                    AND (promise_queue_entry->>'queue_fn_name')::text = (promise_queue_message->>'src')::text
                ) THEN
                    confirmed_match_for_promise := true;
                    EXIT;
                END IF;
            END LOOP;

            IF NOT confirmed_match_for_promise THEN
                not_confirmed_removed_promise_queue_data := array_append(not_confirmed_removed_promise_queue_data, promise_queue_message);
            END IF;
        END LOOP;
    END IF;

    -- 3. Remove schedule queue messages.
    IF confirmed_removed_schedule_queue_data IS NOT NULL THEN
        FOR i IN 1 .. COALESCE(array_length(confirmed_removed_schedule_queue_data, 1), 0) LOOP
            schedule_queue_entry := confirmed_removed_schedule_queue_data[i];
            
            
            
            -- IF remove_from_current_fsm_instance_queue_id IS NOT NULL AND remove_from_current_fsm_instance_queue_id <> '' AND schedule_queue_message->>'type' IS NOT NULL AND schedule_queue_message->>'type' <> '' THEN
                PERFORM pgmq.archive(queue_name := remove_from_current_fsm_instance_queue_id, msg_id := (schedule_queue_entry->>'type')::bigint);
                confirmed_removed_schedule_queue_data_success := array_append(confirmed_removed_schedule_queue_data_success, schedule_queue_entry);
            -- END IF;
        END LOOP;
    END IF;

    -- 4. Cancel events for promise type workers. 
    IF confirmed_removed_promise_queue_data IS NOT NULL THEN
        FOR i IN 1 .. COALESCE(array_length(confirmed_removed_promise_queue_data, 1), 0) LOOP
            promise_queue_entry := confirmed_removed_promise_queue_data[i];
            -- pq_name := promise_queue_entry->>'promise_queue_name';
            -- pq_msg_id := NULL;
            -- BEGIN
                -- pq_msg_id := (promise_queue_entry->>'queue_msg_id')::bigint;
            -- EXCEPTION WHEN invalid_text_representation THEN
            --     pq_msg_id := NULL;
            -- END;
            -- IF pq_name IS NOT NULL AND pq_name <> '' AND pq_msg_id IS NOT NULL THEN
                PERFORM fsm_core.cancel_event_for_fsm_promise_type_worker_v2(
                    promise_type_worker_name := (promise_queue_entry->>'queue_id')::text,
                    queue_msg_id := (promise_queue_entry->>'queue_msg_id')::bigint
                );
                confirmed_removed_promise_queue_data_success := array_append(confirmed_removed_promise_queue_data_success, promise_queue_entry);
            -- END IF;
        END LOOP;
    END IF;

    -- 5. Send new schedule events and collect results
    IF to_be_added_schedule_queue_data IS NOT NULL THEN
        FOR i IN 0 .. jsonb_array_length(to_be_added_schedule_queue_data)-1 LOOP
            to_be_added_schedule_queue_data_entry := to_be_added_schedule_queue_data->i;
            to_be_added_schedule_queue_data_entry_delay := COALESCE((to_be_added_schedule_queue_data_entry->>'delay')::integer, 0) / 1000;
            output_schedule_result := fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
                input_fsm_instance_id := remove_from_current_fsm_instance_queue_id::uuid,
                input_fsm_instance_id_fsm_type := to_be_added_schedule_queue_data_entry->>'fsmType',
                input_fsm_instance_id_fsm_version := to_be_added_schedule_queue_data_entry->>'fsmVersion',
                input_send_to_parent_queue_id := remove_from_current_fsm_instance_queue_id::uuid,
                input_send_to_parent_queue_type := to_be_added_schedule_queue_data_entry->>'fsmType',
                input_send_to_parent_queue_id_event_name := to_be_added_schedule_queue_data_entry->>'id',
                input_event_name := to_be_added_schedule_queue_data_entry->>'id',
                input_event_action_type := to_be_added_schedule_queue_data_entry->>'action_type',
                input_event_data := to_be_added_schedule_queue_data_entry->'input',
                input_event_delay := to_be_added_schedule_queue_data_entry_delay,
                input_event_status := 'ACTIVE',
                input_event_output := '{}'::jsonb,
                input_error_message := NULL
            );
            added_schedule_queue_data := array_append(added_schedule_queue_data, output_schedule_result);
            new_total_schedule_queue_data := new_total_schedule_queue_data || output_schedule_result;
        END LOOP;
    END IF;

    -- 6. Send new promise events and collect results
    IF to_be_added_promise_queue_data IS NOT NULL THEN
        FOR i IN 0 .. jsonb_array_length(to_be_added_promise_queue_data)-1 LOOP
            to_be_added_promise_queue_data_entry := to_be_added_promise_queue_data->i;
            -- IF (to_be_added_promise_queue_data_entry->>'src') IS NOT NULL AND (to_be_added_promise_queue_data_entry->>'src') <> '' THEN
                -- output_promise_result := fsm_core.send_event_to_fsm_promise_queue_from_fsm_instance_id_v2(
                --     to_be_added_promise_queue_data_entry->>'id', -- type can be also used here 
                --     to_be_added_promise_queue_data_entry->'input',
                --     to_be_added_promise_queue_data_entry->>'src',
                --     remove_from_current_fsm_instance_queue_id::uuid
                --     -- CASE WHEN remove_from_current_fsm_instance_queue_id IS NOT NULL AND remove_from_current_fsm_instance_queue_id <> '' THEN remove_from_current_fsm_instance_queue_id::uuid ELSE NULL::uuid END
                -- );

                output_promise_result := fsm_core.send_event_to_queue_from_fsm_instance_id_v2(
                    event_name := to_be_added_promise_queue_data_entry->>'id',
                    event_input := to_be_added_promise_queue_data_entry->'input',
                    id := to_be_added_promise_queue_data_entry->>'id',
                    action_type := to_be_added_promise_queue_data_entry->>'action_type',
                    src := to_be_added_promise_queue_data_entry->>'src',
                    fsmName := to_be_added_promise_queue_data_entry->>'src',
                    fsmType := to_be_added_promise_queue_data_entry->>'fsmType',
                    fsmVersion := to_be_added_promise_queue_data_entry->>'fsmVersion',
                    parentFsmName := to_be_added_promise_queue_data_entry->>'parentFsmName',
                    parentFsmVersion := to_be_added_promise_queue_data_entry->>'parentFsmVersion',
                    from_source_fsm_instance_id := remove_from_current_fsm_instance_queue_id::uuid
                    -- CASE WHEN remove_from_current_fsm_instance_queue_id IS NOT NULL AND remove_from_current_fsm_instance_queue_id <> '' THEN remove_from_current_fsm_instance_queue_id::uuid ELSE NULL::uuid END
                );
            -- ELSE
            --     output_promise_result := NULL;
            -- END IF;
            added_promise_queue_data := array_append(added_promise_queue_data, output_promise_result->'queue_data');
            new_total_promise_queue_data := new_total_promise_queue_data ||  (output_promise_result->'queue_data');
        END LOOP;
    END IF;

    -- 7. Update fsm_instance (pseudo-code, adjust as needed)
    UPDATE fsm_core.fsm_instance
    SET
        total_schedule_queue_data = new_total_schedule_queue_data,
        total_promise_queue_data = new_total_promise_queue_data,
        fsm_instance_status = fsm_instance_data_save_fsm_status,
        fsm_instance_state = fsm_instance_data_save_fsm_state,
        fsm_instance_context = fsm_instance_data_save_fsm_context,
        fsm_instance_xstate_state = fsm_instance_data_save_fsm_xstate_state
    WHERE id = remove_from_current_fsm_instance_queue_id::uuid;

    -- 8. All above macro steps are completed so remove current queue_msg_id from current_workflow_queue_id  
    PERFORM pgmq.archive(queue_name := remove_from_current_fsm_instance_queue_id, msg_id := remove_current_queue_msg_id::bigint);


    RETURN jsonb_build_object(
         'confirmed_removed_schedule_queue_data_success', confirmed_removed_schedule_queue_data_success,
         'confirmed_removed_promise_queue_data_success', confirmed_removed_promise_queue_data_success,
         
         'confirmed_removed_schedule_queue_data_failed', confirmed_removed_schedule_queue_data_failed,
         'confirmed_removed_promise_queue_data_failed', confirmed_removed_promise_queue_data_failed,
         
         'not_confirmed_removed_schedule_queue_data', not_confirmed_removed_schedule_queue_data,
         'not_confirmed_removed_promise_queue_data', not_confirmed_removed_promise_queue_data,  

         'added_schedule_queue_data', added_schedule_queue_data,
         'added_promise_queue_data', added_promise_queue_data,

         'new_total_schedule_queue_data', new_total_schedule_queue_data,
         'new_total_promise_queue_data', new_total_promise_queue_data,

         'old_total_schedule_queue_data', input_total_schedule_queue_data,
         'old_total_promise_queue_data', input_total_promise_queue_data
      );

END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.build_nested_json_recursive(paths text[])
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
    result := fsm_core.jsonb_deep_merge(a := result, b := fsm_core.path_string_to_jsonb(path := path));
  END LOOP;

  RETURN result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.cancel_event_for_fsm_promise_type_worker_v2(promise_type_worker_name text, queue_msg_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
   archive_result BOOLEAN;
BEGIN
   --  1. Remove queue_msg_id from the promise_type_worker_name queue using PGMQ
   -- IF promise_type_worker_name IS NOT NULL AND promise_type_worker_name <> '' AND queue_msg_id IS NOT NULL THEN
    
       archive_result := pgmq.archive(queue_name := promise_type_worker_name, msg_id := queue_msg_id);
   -- ELSE
   --    archive_result := false;
   -- END IF;

    -- 2. Notify all workers via pg_notify (only when queue name present)
    -- IF promise_type_worker_name IS NOT NULL AND promise_type_worker_name <> '' THEN
        PERFORM pg_notify('fsm_promise_worker_' || promise_type_worker_name, COALESCE(queue_msg_id::text, ''));
    -- END IF;

    -- 3. Log event to fsm_promise_queue_event_logs (allow null queue id but record name)
    INSERT INTO fsm_core.fsm_promise_queue_event_logs (
        event_name,
        event_data,
        promise_queue_name,
        promise_queue_msg_id,
        -- send_to_parent_queue_id,
        -- send_to_parent_queue_id_msg_id,
        event_status,
        execution_finished_at
    ) VALUES (
        'cancel',
        NULL,
        promise_type_worker_name,
        queue_msg_id,
        'canceled',
        now()
    );

    RETURN jsonb_build_object(
        'archive_result', archive_result,
        'promise_queue_name', promise_type_worker_name,
        'queue_msg_id', queue_msg_id,
        'status', 'canceled'
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.compute_entry_actions_v1(transition_record fsm_core.fsm_transitions, fsm_name_param text, fsm_version_param text, is_initial_transition boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    sanitized_source_ltree LTREE;
    sanitized_target_ltree_array LTREE[];
    sanitized_target_state TEXT;
    transition_domain_lca ltree;
    reenter_flag BOOLEAN;
    effective_target_states_ltree_array LTREE[];
    sanitized_effective_target_state TEXT;
    ancestors TEXT[];
    ancestors_result RECORD;
    domain_type TEXT;
    child_result RECORD;
    states_to_enter TEXT[];
    states_for_default_entry TEXT[];
    common_states TEXT[] := '{}';
    state_to_check TEXT;
    entry_actions_result JSONB;
    initial_actions_for_common_states_result JSONB;
    resolve_state_value_result JSONB;
    final_result JSONB;
BEGIN

   -- if is_initial_transition true 
   -- then return empty result
    IF is_initial_transition THEN
          select fsm_core.resolve_state_value_v1(input_json := '{}'::jsonb, input_fsm_name := fsm_name_param, input_fsm_version := fsm_version_param) INTO resolve_state_value_result;
        --   states_to_enter := resolve_state_value_result->'all_nodes';
          states_to_enter := array(
                SELECT jsonb_array_elements_text(resolve_state_value_result->'all_nodes')
            );

          SELECT fsm_core.get_entry_actions_v1(p_state_paths := states_to_enter, p_fsm_name := fsm_name_param, p_fsm_version := fsm_version_param) INTO entry_actions_result;
          RETURN jsonb_build_object(
                'states_to_enter', states_to_enter,
                'states_for_default_entry', '[]'::jsonb,
                'common_states', '[]'::jsonb,
                'entry_actions_for_states_to_enter', entry_actions_result::jsonb,
                'initial_actions_for_common_states', '[]'::jsonb
          );
    END IF;
    
    -- If no transition found, return empty result
    IF transition_record IS NULL THEN
        RETURN jsonb_build_object(
            'states_to_enter', '[]'::jsonb,
            'states_for_default_entry', '[]'::jsonb,
            'common_states', '[]'::jsonb,
            'entry_actions_for_states_to_enter', '[]'::jsonb,
            'initial_actions_for_common_states', '[]'::jsonb
        );
    END IF;
    
    
    sanitized_source_ltree := transition_record.computed_sanitized_source_ltree;
   
    sanitized_target_ltree_array := transition_record.computed_sanitized_target_ltree_array;
   

    RAISE NOTICE 'Calculating Transition Domain LCA from transition_record: %', transition_record;

    transition_domain_lca := fsm_core.sql_lca_from_array(
        paths := ARRAY[transition_record.computed_sanitized_source_ltree::ltree] || transition_record.computed_sanitized_target_ltree_array
    );

    reenter_flag := COALESCE((transition_record.reenter)::BOOLEAN, FALSE);
    
    -- Part 1 : add all target state node and call addDescendantStatesToEnter to add all inital and node childern nodes
    -- Call getStatesForEntry with the transition record and fsm parameters
    -- result := getStatesForEntry(source_state, target_states_json, transition_domain_lca::TEXT, reenter_flag, fsm_name_param, fsm_version_param);
    -- above line is and getStatesForEntry fn replaced with below code
    RAISE NOTICE 'sanitized_target_ltree_array: %', sanitized_target_ltree_array;
    IF sanitized_target_ltree_array IS NOT NULL AND array_length(sanitized_target_ltree_array, 1) > 0 THEN
        FOR sanitized_target_state IN SELECT unnest(sanitized_target_ltree_array)
        LOOP
            
            -- Apply the logic from the JavaScript code
            IF (
                -- if the target is different than the source then it will *definitely* be entered
                sanitized_source_ltree::TEXT != sanitized_target_state::TEXT OR
                -- we know that the domain can't lie within the source
                -- if it's different than the source then it's outside of it and it means that the target has to be entered as well
                sanitized_source_ltree::TEXT != transition_domain_lca::TEXT OR
                -- reentering transitions always enter the target, even if it's the source itself
                reenter_flag
            ) THEN
                
                -- Add to states_to_enter if not already present
                
                    states_to_enter := array_append(states_to_enter, sanitized_target_state);
                
                    states_for_default_entry := array_append(states_for_default_entry, sanitized_target_state);
                
                    RAISE NOTICE 'states_to_enter: %', states_to_enter;
            END IF;

            RAISE NOTICE 'Before fsm_core.get_descendant_states_for_entry_v1 for sanitized_target_state: %', sanitized_target_state;
            RAISE NOTICE 'states_to_enter: %', states_to_enter;
            RAISE NOTICE 'states_for_default_entry: %', states_for_default_entry;
            
            -- call fsm_core.get_descendant_states_for_entry_v1 for each child state
            child_result := fsm_core.get_descendant_states_for_entry_v1(input_state_id := sanitized_target_state::text, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param);
            RAISE NOTICE 'After fsm_core.get_descendant_states_for_entry_v1 for sanitized_target_state: %', sanitized_target_state;
            RAISE NOTICE 'child_result: %', child_result;
            states_to_enter := array_cat(states_to_enter, child_result.descendant_states_to_enter);
            states_for_default_entry := array_cat(states_for_default_entry, child_result.descendant_states_for_default_entry);
            RAISE NOTICE 'states_to_enter: %', states_to_enter;
            RAISE NOTICE 'states_for_default_entry: %', states_for_default_entry;
        END LOOP;
    END IF;

    -- Part 2 : add all inbetween state nodes from domain to target state node

    SELECT type INTO domain_type FROM fsm_core.fsm_states
                WHERE computed_state_key_ltree = transition_domain_lca
                  AND fsm_name = fsm_name_param
                  AND fsm_version = fsm_version_param;

    -- TODO : pending fn of getEffectiveTargetStates would be transition_json -> 'target';
    effective_target_states_ltree_array = transition_record.computed_sanitized_target_ltree_array;
    RAISE NOTICE 'effective_target_states_ltree_array: %', effective_target_states_ltree_array;
    -- for (const s of effective_target_states) {
    --   const ancestors = get_proper_ancestors(s, domain);
    --   if (domain?.type === 'parallel') {
    --     ancestors.push(domain);
    --   }
    --   fsm_core.get_ancestor_states_for_entry_v1(
    --     statesToEnter,
    --     historyValue,
    --     statesForDefaultEntry,
    --     ancestors,
    --     !t.source.parent && t.reenter ? undefined : domain
    --   );
    -- }

    IF effective_target_states_ltree_array IS NOT NULL AND array_length(effective_target_states_ltree_array, 1) > 0 THEN
        FOR sanitized_effective_target_state IN SELECT unnest(effective_target_states_ltree_array)
        LOOP

            

            -- Get ancestors for s and domain
            ancestors := fsm_core.get_proper_ancestors(state_path_ltree := sanitized_effective_target_state::TEXT, to_state_path_ltree := transition_domain_lca::TEXT);

            -- If domain is parallel, append domain to ancestors
            IF domain_type = 'parallel' THEN
                ancestors := array_append(ancestors, transition_domain_lca::TEXT);
            END IF;

            
            ancestors_result := fsm_core.get_ancestor_states_for_entry_v1(
                ancestors := ancestors,
                reentrancy_domain := CASE WHEN transition_record.source IS NULL AND transition_record.reenter THEN NULL ELSE transition_domain_lca::TEXT END,
                fsm_name_param := fsm_name_param,
                fsm_version_param := fsm_version_param
            );

            states_to_enter := array_cat(states_to_enter, ancestors_result.ancestor_states_to_enter);

        END LOOP;
    END IF;

    RAISE NOTICE 'Final states_to_enter before dedup: %', states_to_enter;
    RAISE NOTICE 'Final states_for_default_entry before dedup: %', states_for_default_entry;
  
    
    -- Find common elements between states_to_enter and states_for_default_entry
    FOR state_to_check IN SELECT unnest(states_to_enter)
    LOOP
        -- Check if statesForDefaultEntry has this stateNodeToEnter
        IF state_to_check = ANY(states_for_default_entry) THEN
            -- Add to common_states (actions array equivalent)
            common_states := array_append(common_states, state_to_check);
        END IF;
    END LOOP;
    
    -- Log the common states found
    RAISE NOTICE 'Common states found: %', common_states;
        
        
  

    -- Get entry actions for states_to_enter
    SELECT fsm_core.get_entry_actions_v1(p_state_paths := states_to_enter, p_fsm_name := fsm_name_param, p_fsm_version := fsm_version_param) INTO entry_actions_result;

    -- -- Get entry actions for states_for_default_entry
    -- SELECT fsm_core.get_entry_actions_v1(states_for_default_entry, fsm_name_param, fsm_version_param) INTO default_entry_actions_result;
    -- Get entry actions for the common states
    IF array_length(common_states, 1) > 0 THEN
        SELECT fsm_core.get_initial_actions_v1(p_state_paths := common_states, p_fsm_name := fsm_name_param, p_fsm_version := fsm_version_param) INTO initial_actions_for_common_states_result;
    END IF;


    -- Build the final result containing both arrays and their respective actions
    final_result := jsonb_build_object(
        'states_to_enter', to_jsonb(states_to_enter),
        'states_for_default_entry', to_jsonb(states_for_default_entry),
        'common_states', to_jsonb(common_states),
        'entry_actions_for_states_to_enter', entry_actions_result,
        'initial_actions_for_common_states', initial_actions_for_common_states_result
    );

    RETURN final_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.compute_entry_actions_v2(transition_record fsm_core.fsm_transitions, fsm_name_param text, fsm_version_param text, is_initial_transition boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    sanitized_source_ltree LTREE;
    sanitized_target_ltree_array LTREE[];
    sanitized_target_state TEXT;
    transition_domain_lca ltree;
    reenter_flag BOOLEAN;
    effective_target_states_ltree_array LTREE[];
    sanitized_effective_target_state TEXT;
    ancestors TEXT[];
    ancestors_result RECORD;
    domain_type TEXT;
    child_result RECORD;
    states_to_enter TEXT[];
    states_for_default_entry TEXT[];
    common_states TEXT[] := '{}';
    state_to_check TEXT;
    entry_actions_result JSONB;
    initial_actions_for_common_states_result JSONB;
    resolve_state_value_result JSONB;
    final_result JSONB;
BEGIN

   -- if is_initial_transition true 
   -- then return empty result
    IF is_initial_transition THEN
          select fsm_core.resolve_state_value_v2(input_json := '{}'::jsonb, input_fsm_name := fsm_name_param, input_fsm_version := fsm_version_param) INTO resolve_state_value_result;
        --   states_to_enter := resolve_state_value_result->'all_nodes';
          states_to_enter := array(
                SELECT jsonb_array_elements_text(resolve_state_value_result->'all_nodes')
            );

          SELECT fsm_core.get_entry_actions_v2(p_state_paths := states_to_enter, p_fsm_name := fsm_name_param, p_fsm_version := fsm_version_param) INTO entry_actions_result;
          RETURN jsonb_build_object(
                'states_to_enter', states_to_enter,
                'states_for_default_entry', '[]'::jsonb,
                'common_states', '[]'::jsonb,
                'entry_actions_for_states_to_enter', entry_actions_result::jsonb,
                'initial_actions_for_common_states', '[]'::jsonb
          );
    END IF;
    
    -- If no transition found, return empty result
    IF transition_record IS NULL THEN
        RETURN jsonb_build_object(
            'states_to_enter', '[]'::jsonb,
            'states_for_default_entry', '[]'::jsonb,
            'common_states', '[]'::jsonb,
            'entry_actions_for_states_to_enter', '[]'::jsonb,
            'initial_actions_for_common_states', '[]'::jsonb
        );
    END IF;
    
    
    sanitized_source_ltree := transition_record.computed_sanitized_source_ltree;
   
    sanitized_target_ltree_array := transition_record.computed_sanitized_target_ltree_array;
   

    RAISE NOTICE 'Skipped Calculating Transition Domain LCA from transition_record: %', transition_record;

    RAISE NOTICE 'Fetching Transition Domain LCA from transition_record: %', transition_record;

    transition_domain_lca := transition_record.computed_transition_domain_lca;


    reenter_flag := COALESCE((transition_record.reenter)::BOOLEAN, FALSE);
    
    -- Part 1 : add all target state node and call addDescendantStatesToEnter to add all inital and node childern nodes
    -- Call getStatesForEntry with the transition record and fsm parameters
    -- result := getStatesForEntry(source_state, target_states_json, transition_domain_lca::TEXT, reenter_flag, fsm_name_param, fsm_version_param);
    -- above line is and getStatesForEntry fn replaced with below code
    RAISE NOTICE 'sanitized_target_ltree_array: %', sanitized_target_ltree_array;
    IF sanitized_target_ltree_array IS NOT NULL AND array_length(sanitized_target_ltree_array, 1) > 0 THEN
        FOR sanitized_target_state IN SELECT unnest(sanitized_target_ltree_array)
        LOOP
            
            -- Apply the logic from the JavaScript code
            IF (
                -- if the target is different than the source then it will *definitely* be entered
                sanitized_source_ltree::TEXT != sanitized_target_state::TEXT OR
                -- we know that the domain can't lie within the source
                -- if it's different than the source then it's outside of it and it means that the target has to be entered as well
                sanitized_source_ltree::TEXT != transition_domain_lca::TEXT OR
                -- reentering transitions always enter the target, even if it's the source itself
                reenter_flag
            ) THEN
                
                -- Add to states_to_enter if not already present
                
                    states_to_enter := array_append(states_to_enter, sanitized_target_state);
                
                    states_for_default_entry := array_append(states_for_default_entry, sanitized_target_state);
                
                    RAISE NOTICE 'states_to_enter: %', states_to_enter;
            END IF;

            RAISE NOTICE 'Before fsm_core.get_descendant_states_for_entry_v2 for sanitized_target_state: %', sanitized_target_state;
            RAISE NOTICE 'states_to_enter: %', states_to_enter;
            RAISE NOTICE 'states_for_default_entry: %', states_for_default_entry;
            
            -- call fsm_core.get_descendant_states_for_entry_v2 for each child state
            child_result := fsm_core.get_descendant_states_for_entry_v2(input_state_id := sanitized_target_state::text, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param);
            RAISE NOTICE 'After fsm_core.get_descendant_states_for_entry_v2 for sanitized_target_state: %', sanitized_target_state;
            RAISE NOTICE 'child_result: %', child_result;
            states_to_enter := array_cat(states_to_enter, child_result.descendant_states_to_enter);
            states_for_default_entry := array_cat(states_for_default_entry, child_result.descendant_states_for_default_entry);
            RAISE NOTICE 'states_to_enter: %', states_to_enter;
            RAISE NOTICE 'states_for_default_entry: %', states_for_default_entry;
        END LOOP;
    END IF;

    -- Part 2 : add all inbetween state nodes from domain to target state node

    SELECT type INTO domain_type FROM fsm_core.fsm_states
                WHERE computed_state_key_ltree = transition_domain_lca
                  AND fsm_name = fsm_name_param
                  AND fsm_version = fsm_version_param;

    -- TODO : pending fn of getEffectiveTargetStates would be transition_json -> 'target';
    effective_target_states_ltree_array = transition_record.computed_sanitized_target_ltree_array;
    RAISE NOTICE 'effective_target_states_ltree_array: %', effective_target_states_ltree_array;
    -- for (const s of effective_target_states) {
    --   const ancestors = get_proper_ancestors(s, domain);
    --   if (domain?.type === 'parallel') {
    --     ancestors.push(domain);
    --   }
    --   fsm_core.get_ancestor_states_for_entry_v2(
    --     statesToEnter,
    --     historyValue,
    --     statesForDefaultEntry,
    --     ancestors,
    --     !t.source.parent && t.reenter ? undefined : domain
    --   );
    -- }

    IF effective_target_states_ltree_array IS NOT NULL AND array_length(effective_target_states_ltree_array, 1) > 0 THEN
        FOR sanitized_effective_target_state IN SELECT unnest(effective_target_states_ltree_array)
        LOOP

            

            -- Get ancestors for s and domain
            ancestors := fsm_core.get_proper_ancestors(state_path_ltree := sanitized_effective_target_state::TEXT, to_state_path_ltree := transition_domain_lca::TEXT);

            -- If domain is parallel, append domain to ancestors
            IF domain_type = 'parallel' THEN
                ancestors := array_append(ancestors, transition_domain_lca::TEXT);
            END IF;

            
            ancestors_result := fsm_core.get_ancestor_states_for_entry_v2(
                ancestors := ancestors,
                reentrancy_domain := CASE WHEN transition_record.source IS NULL AND transition_record.reenter THEN NULL ELSE transition_domain_lca::TEXT END,
                fsm_name_param := fsm_name_param,
                fsm_version_param := fsm_version_param
            );

            states_to_enter := array_cat(states_to_enter, ancestors_result.ancestor_states_to_enter);

        END LOOP;
    END IF;

    RAISE NOTICE 'Final states_to_enter before dedup: %', states_to_enter;
    RAISE NOTICE 'Final states_for_default_entry before dedup: %', states_for_default_entry;
  
    
    -- Find common elements between states_to_enter and states_for_default_entry
    FOR state_to_check IN SELECT unnest(states_to_enter)
    LOOP
        -- Check if statesForDefaultEntry has this stateNodeToEnter
        IF state_to_check = ANY(states_for_default_entry) THEN
            -- Add to common_states (actions array equivalent)
            common_states := array_append(common_states, state_to_check);
        END IF;
    END LOOP;
    
    -- Log the common states found
    RAISE NOTICE 'Common states found: %', common_states;
        
        
  

    -- Get entry actions for states_to_enter
    SELECT fsm_core.get_entry_actions_v2(p_state_paths := states_to_enter, p_fsm_name := fsm_name_param, p_fsm_version := fsm_version_param) INTO entry_actions_result;

    -- -- Get entry actions for states_for_default_entry
    -- SELECT fsm_core.get_entry_actions_v2(states_for_default_entry, fsm_name_param, fsm_version_param) INTO default_entry_actions_result;
    -- Get entry actions for the common states
    IF array_length(common_states, 1) > 0 THEN
        SELECT fsm_core.get_initial_actions_v2(p_state_paths := common_states, p_fsm_name := fsm_name_param, p_fsm_version := fsm_version_param) INTO initial_actions_for_common_states_result;
    END IF;


    -- Build the final result containing both arrays and their respective actions
    final_result := jsonb_build_object(
        'states_to_enter', to_jsonb(states_to_enter),
        'states_for_default_entry', to_jsonb(states_for_default_entry),
        'common_states', to_jsonb(common_states),
        'entry_actions_for_states_to_enter', entry_actions_result,
        'initial_actions_for_common_states', initial_actions_for_common_states_result
    );

    RETURN final_result;
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
  SELECT fsm_core.compute_full_exit_set_v1(transition_record := transition_record, state_node_set := p_state_node_set) INTO exit_set_result;

  RAISE NOTICE 'Exit Set Result: %', exit_set_result;

  -- Step 2: Call fsm_core.get_exit_actions_v1 with the result from step 1
  SELECT fsm_core.get_exit_actions_v1(p_state_paths := exit_set_result, p_fsm_name := p_fsm_name, p_fsm_version := p_fsm_version) INTO actions_result;

  RAISE NOTICE 'exit_actions Result: %', actions_result;

  -- Return both exit_nodes and exit_actions as a JSON object
  RETURN jsonb_build_object(
    'exit_nodes', exit_set_result,
    'exit_actions', actions_result->'actions'
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.compute_exit_actions_v2(transition_record fsm_core.fsm_transitions, p_state_node_set text[], p_fsm_name text, p_fsm_version text)
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
  SELECT fsm_core.compute_full_exit_set_v2(transition_record := transition_record, state_node_set := p_state_node_set) INTO exit_set_result;

  RAISE NOTICE 'Exit Set Result: %', exit_set_result;

  -- Step 2: Call fsm_core.get_exit_actions_v2 with the result from step 1
  SELECT fsm_core.get_exit_actions_v2(p_state_paths := exit_set_result, p_fsm_name := p_fsm_name, p_fsm_version := p_fsm_version) INTO actions_result;

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
      paths := ARRAY[transition_record.computed_sanitized_source_ltree::ltree] || transition_record.computed_sanitized_target_ltree_array
  );


  state_node_set_ltree = fsm_core.sanitize_text_array_to_ltree_array(input_array := state_node_set);
  -- call child exit set using the domain text (fsm_core.compute_child_exit_set_v1 will sanitize)
  child_exit := fsm_core.compute_child_exit_set_v1(transition_domain_lca := transition_domain_lca, state_node_set := state_node_set_ltree);

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

CREATE OR REPLACE FUNCTION fsm_core.compute_full_exit_set_v2(transition_record fsm_core.fsm_transitions, state_node_set text[])
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


  RAISE NOTICE 'Skipped Calculating Transition Domain LCA from transition_record: %', transition_record;

  RAISE NOTICE 'Fetching Transition Domain LCA from transition_record: %', transition_record;

  transition_domain_lca := transition_record.computed_transition_domain_lca;

  state_node_set_ltree = fsm_core.sanitize_text_array_to_ltree_array(input_array := state_node_set);
  -- call child exit set using the domain text (fsm_core.compute_child_exit_set_v2 will sanitize)
  child_exit := fsm_core.compute_child_exit_set_v2(transition_domain_lca := transition_domain_lca, state_node_set := state_node_set_ltree);

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

CREATE OR REPLACE FUNCTION fsm_core.create_fsm_instance_from_name_v2(input_fsm_name text, input_fsm_version text, input_fsm_context jsonb, create_pgmq_queue boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    output_queue_created boolean := false;
    output_message text := NULL;
    output_extra_message text := NULL;
    fsm_instance_id uuid;
    send_event_result jsonb := NULL;
    derived_fsm_type text;
BEGIN
    -- 1. Check if fsm_name and fsm_version exist in fsm_core.fsm_json and get fsm_type
    SELECT fj.fsm_type INTO derived_fsm_type
    FROM fsm_core.fsm_json fj
    WHERE fj.fsm_name = input_fsm_name AND fj.fsm_version = input_fsm_version;

    IF derived_fsm_type IS NULL THEN
        RAISE EXCEPTION 'FSM with name % and version % not found in fsm_core.fsm_json', input_fsm_name, input_fsm_version;
    END IF;

    -- 2. Create new fsm_instance
    INSERT INTO fsm_core.fsm_instance (fsm_name, fsm_version, fsm_instance_context)
    VALUES (input_fsm_name, input_fsm_version, input_fsm_context)
    RETURNING id INTO fsm_instance_id;

    -- 3. Insert all transitions into fsm_core.fsm_instance_transitions_auth
    INSERT INTO fsm_core.fsm_instance_transitions_auth (
        fsm_name, fsm_version, fsm_instance_id, fsm_instance_event_type, users, groups, module_tag, meta_info
    )
    SELECT 
        t.fsm_name,
        t.fsm_version,
        fsm_instance_id,
        t.event_type,
        ARRAY[]::jsonb[], -- users (default empty array)
        ARRAY[]::jsonb[], -- groups (default empty array)
        NULL::jsonb,      -- module_tag (default null)
        NULL::jsonb       -- meta_info (default null)
    FROM fsm_core.fsm_transitions t
    WHERE t.fsm_name = input_fsm_name AND t.fsm_version = input_fsm_version;

    -- 4. Optionally create pgmq queue and send initial event
    IF create_pgmq_queue THEN
        BEGIN
            PERFORM pgmq.create(queue_name := fsm_instance_id::text);
            output_queue_created := true;
            output_message := 'Queue created successfully.';
            -- Try to send initialTransition_event to the queue
            BEGIN
                send_event_result := fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
                    input_fsm_instance_id := fsm_instance_id,
                    input_fsm_instance_id_fsm_type := derived_fsm_type,
                    input_fsm_instance_id_fsm_version := input_fsm_version,
                    input_send_to_parent_queue_id := NULL,
                    input_send_to_parent_queue_type := NULL,
                    input_send_to_parent_queue_id_event_name := NULL,
                    input_event_name := 'initialTransition_event',
                    input_event_action_type := 'system',
                    input_event_data := jsonb_build_object('source', 'system'),
                    input_event_delay := 0,
                    input_event_status := 'fsm_started',
                    input_event_output := '{}'::jsonb,
                    input_error_message := NULL,
                    input_execution_started_at := now(),
                    input_execution_duration := NULL,
                    input_execution_finished_at := now()
                );
                output_extra_message := 'initialTransition_event is also sent to queue.';
            EXCEPTION WHEN OTHERS THEN
                output_extra_message := SQLERRM;
            END;
        EXCEPTION WHEN OTHERS THEN
            output_queue_created := false;
            output_message := SQLERRM;
        END;
    ELSE
        output_queue_created := false;
        output_message := 'queue_created is false and no queue is created.';
        output_extra_message := NULL;
    END IF;

    RETURN jsonb_build_object(
        'queue_created', output_queue_created,
        'fsm_name', input_fsm_name,
        'fsm_version', input_fsm_version,
        'fsm_instance_id', fsm_instance_id,
        'fsm_instance_context', input_fsm_context,
        'send_event_result', send_event_result,
        'message', output_message,
        'extra_message', output_extra_message
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.fsm_get_all_state_nodes_v1(p_state_paths text[], p_fsm_name text, p_fsm_version text)
 RETURNS text[]
 LANGUAGE plpgsql
AS $function$
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
    RAISE NOTICE '[fsm_core.fsm_get_all_state_nodes_v1] Input state_paths: %', p_state_paths;
    
    SELECT array_agg(fsm_states ORDER BY fsm_order ASC) INTO all_fsm_states
    FROM fsm_core.fsm_states
    WHERE fsm_name = p_fsm_name AND fsm_version = p_fsm_version AND computed_state_key_ltree::text = ANY(p_state_paths);

    RAISE NOTICE '[fsm_core.fsm_get_all_state_nodes_v1] Matching fsm_core.fsm_states count: %', array_length(all_fsm_states, 1);

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
                initialStates := fsm_core.fsm_get_initial_state_nodes_with_ancestors_v1(p_fsm_name := p_fsm_name, p_fsm_version := p_fsm_version, p_state_path := node_rec.computed_state_key_ltree::ltree);
               
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
                    
                    initialStates := fsm_core.fsm_get_initial_state_nodes_with_ancestors_v1(p_fsm_name := p_fsm_name, p_fsm_version := p_fsm_version, p_state_path := fsm_core.sanitize_text_to_ltree(input_text := child_rec.value->>'id'));
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

   
    RAISE NOTICE '[fsm_core.fsm_get_all_state_nodes_v1] Log:%', log_text;
    RAISE NOTICE '[fsm_core.fsm_get_all_state_nodes_v1] ResultNodeset: %', resultNodeset;
    RETURN COALESCE(resultNodeset, ARRAY[]::text[]);
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.fsm_get_all_state_nodes_v2(p_state_paths text[], p_fsm_name text, p_fsm_version text)
 RETURNS text[]
 LANGUAGE plpgsql
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.fsm_get_initial_state_nodes_v1(p_fsm_name text, p_fsm_version text, p_state_path ltree)
 RETURNS text[]
 LANGUAGE plpgsql
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.fsm_get_initial_state_nodes_v2(p_fsm_name text, p_fsm_version text, p_state_path ltree)
 RETURNS text[]
 LANGUAGE plpgsql
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.fsm_get_initial_state_nodes_with_ancestors_v1(p_fsm_name text, p_fsm_version text, p_state_path ltree)
 RETURNS text[]
 LANGUAGE plpgsql
AS $function$
DECLARE
    initial_nodes text[];
    all_nodes text[] := ARRAY[]::text[];
    node text;
    ancestors text[];
BEGIN
    -- Get initial state nodes
    initial_nodes := fsm_core.fsm_get_initial_state_nodes_v1(p_fsm_name := p_fsm_name, p_fsm_version := p_fsm_version, p_state_path := p_state_path);

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
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.fsm_get_initial_state_nodes_with_ancestors_v2(p_fsm_name text, p_fsm_version text, p_state_path ltree)
 RETURNS text[]
 LANGUAGE plpgsql
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.fsm_worker_v1(event_name text, p_state_value jsonb, fsm_name_param text, fsm_version_param text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
	resolve_state_value_result JSONB;
	state_node_set TEXT[];
	
	macrostep_result JSONB;
BEGIN
	RAISE NOTICE 'fsm_core.fsm_worker_v1 called with event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;

	
	-- in Actual Language, single SQL function like get_fsm_data_and_resolve_state_value can be called which internally calls get_fsm_data and resolve_state_value, here we are calling resolve_state_value directly for simplicity
	-- assume p_state_value value would be drived from get_fsm_data function which fetches the current state value from database based on fsm_name and fsm_version, and then resolve_state_value function resolves it to get the set of active state nodes
	select fsm_core.resolve_state_value_v1(input_json := p_state_value::jsonb, input_fsm_name := fsm_name_param, input_fsm_version := fsm_version_param) INTO resolve_state_value_result;

	RAISE NOTICE 'resolve_state_value_result: %', resolve_state_value_result;
	state_node_set := array(
		SELECT jsonb_array_elements_text(resolve_state_value_result->'all_nodes')
	);
	
	RAISE NOTICE 'state_node_set: %', state_node_set;

	
	-- Call fsm_core.macrostep_v1 and return its JSONB result
	macrostep_result := fsm_core.macrostep_v1(
		event_name := event_name,
		p_state_value := state_node_set,
		fsm_name_param := fsm_name_param,
		fsm_version_param := fsm_version_param
	);

	RAISE NOTICE 'fsm_core.macrostep_v1: %', macrostep_result;

	-- call archive_event_from_fsm_type_worker with right Data

	RETURN macrostep_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.fsm_worker_v2(event_name text, p_state_value jsonb, fsm_name_param text, fsm_version_param text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
	resolve_state_value_result JSONB;
	state_node_set TEXT[];
	
	macrostep_result JSONB;
BEGIN
	RAISE NOTICE 'fsm_core.fsm_worker_v2 called with event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;

	
	-- in Actual Language, single SQL function like get_fsm_data_and_resolve_state_value can be called which internally calls get_fsm_data and resolve_state_value, here we are calling resolve_state_value directly for simplicity
	-- assume p_state_value value would be drived from get_fsm_data function which fetches the current state value from database based on fsm_name and fsm_version, and then resolve_state_value function resolves it to get the set of active state nodes
	select fsm_core.resolve_state_value_v2(input_json := p_state_value::jsonb, input_fsm_name := fsm_name_param, input_fsm_version := fsm_version_param) INTO resolve_state_value_result;

	RAISE NOTICE 'resolve_state_value_result: %', resolve_state_value_result;
	state_node_set := array(
		SELECT jsonb_array_elements_text(resolve_state_value_result->'all_nodes')
	);
	
	RAISE NOTICE 'state_node_set: %', state_node_set;

	
	-- Call fsm_core.macrostep_v2 and return its JSONB result
	macrostep_result := fsm_core.macrostep_v2(
		event_name := event_name,
		p_state_value := state_node_set,
		fsm_name_param := fsm_name_param,
		fsm_version_param := fsm_version_param
	);

	RAISE NOTICE 'fsm_core.macrostep_v2: %', macrostep_result;

	-- call archive_event_from_fsm_type_worker with right Data

	RETURN macrostep_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.get_ancestor_states_for_entry_v1(ancestors text[], reentrancy_domain text, fsm_name_param text, fsm_version_param text)
 RETURNS fsm_core.ancestor_states_result_v1
 LANGUAGE plpgsql
AS $function$
DECLARE
    ancestor_states_to_enter TEXT[] := ARRAY[]::TEXT[];
    ancestor_states_for_default_entry TEXT[] := ARRAY[]::TEXT[];
    anc TEXT;
    anc_record fsm_core.fsm_states;
    child_state JSONB;
    child_id TEXT;
    sanitized_child_id TEXT;
    sanitized_child_id_ltree LTREE;
    is_descendant BOOLEAN;
    child_result RECORD;
    i INT;
    result fsm_core.ancestor_states_result_v1;
BEGIN
    FOREACH anc IN ARRAY ancestors LOOP
        -- If no reentrancy_domain or anc is descendant of reentrancy_domain, add to ancestor_states_to_enter
        IF reentrancy_domain IS NULL OR anc::ltree <@ reentrancy_domain::ltree THEN
            IF NOT (anc = ANY(ancestor_states_to_enter)) THEN
                ancestor_states_to_enter := array_append(ancestor_states_to_enter, anc);
            END IF;
        END IF;

        -- Check if ancestor is a parallel state
        SELECT * INTO anc_record
        FROM fsm_core.fsm_states
        WHERE computed_state_key_ltree = anc::ltree
          AND fsm_name = fsm_name_param
          AND fsm_version = fsm_version_param
        LIMIT 1;

        IF anc_record.type = 'parallel' THEN
            -- For each child of the parallel state
            IF anc_record.states IS NOT NULL THEN
                FOR child_state IN SELECT value FROM jsonb_each(anc_record.states)
                LOOP
                    child_id := child_state->>'id';
                    -- Sanitize child_id
                    sanitized_child_id := fsm_core.sanitize_text_to_ltree(input_text := child_id)::TEXT;
                    SELECT computed_state_key_ltree INTO sanitized_child_id_ltree
                    FROM fsm_core.fsm_states
                    WHERE computed_state_id_ltree = sanitized_child_id::ltree;
                    -- Only add child if no state in ancestor_states_to_enter is a descendant of child
                    is_descendant := FALSE;
                    IF sanitized_child_id_ltree::TEXT IS NOT NULL THEN
                        FOR i IN 1..array_length(ancestor_states_to_enter, 1) LOOP
                            IF ancestor_states_to_enter[i]::ltree <@ sanitized_child_id_ltree::ltree THEN
                                is_descendant := TRUE;
                                EXIT;
                            END IF;
                        END LOOP;
                        IF NOT is_descendant THEN
                            ancestor_states_to_enter := array_append(ancestor_states_to_enter, sanitized_child_id_ltree::text);
                           
                           
                            -- Optionally, add descendants here if needed
                            child_result := fsm_core.get_descendant_states_for_entry_v1(input_state_id := sanitized_child_id_ltree::text, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param);
                            
                            -- TODO: DIFF:: only child_result would be added in both place ancestor_states_to_enter and ancestor_states_for_default_entry 
                            ancestor_states_to_enter := array_cat(ancestor_states_to_enter, child_result.descendant_states_to_enter);
                            ancestor_states_for_default_entry := array_cat(ancestor_states_for_default_entry, child_result.descendant_states_for_default_entry);
                        END IF;
                    END IF;
                END LOOP;
            END IF;
        END IF;
    END LOOP;

    -- Remove duplicates before returning
    SELECT array_agg(DISTINCT s) INTO ancestor_states_to_enter FROM unnest(ancestor_states_to_enter) AS s;
    SELECT array_agg(DISTINCT s) INTO ancestor_states_for_default_entry FROM unnest(ancestor_states_for_default_entry) AS s;
    
    -- Prepare result
    result.ancestor_states_to_enter := COALESCE(ancestor_states_to_enter, ARRAY[]::TEXT[]);
    result.ancestor_states_for_default_entry := COALESCE(ancestor_states_for_default_entry, ARRAY[]::TEXT[]);
    
    RETURN result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.get_ancestor_states_for_entry_v2(ancestors text[], reentrancy_domain text, fsm_name_param text, fsm_version_param text)
 RETURNS fsm_core.ancestor_states_result_v2
 LANGUAGE plpgsql
AS $function$
DECLARE
    ancestor_states_to_enter TEXT[] := ARRAY[]::TEXT[];
    ancestor_states_for_default_entry TEXT[] := ARRAY[]::TEXT[];
    anc TEXT;
    anc_record fsm_core.fsm_states;
    child_state JSONB;
    child_id TEXT;
    sanitized_child_id TEXT;
    sanitized_child_id_ltree LTREE;
    is_descendant BOOLEAN;
    child_result RECORD;
    i INT;
    result fsm_core.ancestor_states_result_v2;
BEGIN
    FOREACH anc IN ARRAY ancestors LOOP
        -- If no reentrancy_domain or anc is descendant of reentrancy_domain, add to ancestor_states_to_enter
        IF reentrancy_domain IS NULL OR anc::ltree <@ reentrancy_domain::ltree THEN
            IF NOT (anc = ANY(ancestor_states_to_enter)) THEN
                ancestor_states_to_enter := array_append(ancestor_states_to_enter, anc);
            END IF;
        END IF;

        -- Check if ancestor is a parallel state
        SELECT * INTO anc_record
        FROM fsm_core.fsm_states
        WHERE computed_state_key_ltree = anc::ltree
          AND fsm_name = fsm_name_param
          AND fsm_version = fsm_version_param
        LIMIT 1;

        IF anc_record.type = 'parallel' THEN
            -- For each child of the parallel state
            IF anc_record.states IS NOT NULL THEN
                FOR child_state IN SELECT value FROM jsonb_each(anc_record.states)
                LOOP
                    child_id := child_state->>'id';
                    -- Sanitize child_id
                    sanitized_child_id := fsm_core.sanitize_text_to_ltree(input_text := child_id)::TEXT;
                    SELECT computed_state_key_ltree INTO sanitized_child_id_ltree
                    FROM fsm_core.fsm_states
                    WHERE computed_state_id_ltree = sanitized_child_id::ltree;
                    -- Only add child if no state in ancestor_states_to_enter is a descendant of child
                    is_descendant := FALSE;
                    IF sanitized_child_id_ltree::TEXT IS NOT NULL THEN
                        FOR i IN 1..array_length(ancestor_states_to_enter, 1) LOOP
                            IF ancestor_states_to_enter[i]::ltree <@ sanitized_child_id_ltree::ltree THEN
                                is_descendant := TRUE;
                                EXIT;
                            END IF;
                        END LOOP;
                        IF NOT is_descendant THEN
                            ancestor_states_to_enter := array_append(ancestor_states_to_enter, sanitized_child_id_ltree::text);
                           
                           
                            -- Optionally, add descendants here if needed
                            child_result := fsm_core.get_descendant_states_for_entry_v2(input_state_id := sanitized_child_id_ltree::text, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param);
                            
                            -- TODO: DIFF:: only child_result would be added in both place ancestor_states_to_enter and ancestor_states_for_default_entry 
                            ancestor_states_to_enter := array_cat(ancestor_states_to_enter, child_result.descendant_states_to_enter);
                            ancestor_states_for_default_entry := array_cat(ancestor_states_for_default_entry, child_result.descendant_states_for_default_entry);
                        END IF;
                    END IF;
                END LOOP;
            END IF;
        END IF;
    END LOOP;

    -- Remove duplicates before returning
    SELECT array_agg(DISTINCT s) INTO ancestor_states_to_enter FROM unnest(ancestor_states_to_enter) AS s;
    SELECT array_agg(DISTINCT s) INTO ancestor_states_for_default_entry FROM unnest(ancestor_states_for_default_entry) AS s;
    
    -- Prepare result
    result.ancestor_states_to_enter := COALESCE(ancestor_states_to_enter, ARRAY[]::TEXT[]);
    result.ancestor_states_for_default_entry := COALESCE(ancestor_states_for_default_entry, ARRAY[]::TEXT[]);
    
    RETURN result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.get_descendant_states_for_entry_v1(input_state_id text, fsm_name_param text, fsm_version_param text)
 RETURNS fsm_core.descendant_states_result_v1
 LANGUAGE plpgsql
AS $function$
DECLARE
    result fsm_core.descendant_states_result_v1;
    descendant_states_to_enter TEXT[] := ARRAY[]::TEXT[];
    descendant_states_for_default_entry TEXT[] := ARRAY[]::TEXT[];
    state_record fsm_core.fsm_states;
    child_states JSONB;
    child_state JSONB;
    child_id TEXT;
    sanitized_child_id TEXT;
    sanitized_child_id_ltree LTREE;
    initial_state TEXT;
    sanitized_initial_state TEXT;
    sanitized_initial_state_ltree LTREE;
    child_result fsm_core.descendant_states_result_v1;
    ancestors TEXT[];
    ancestors_result RECORD;
BEGIN
    -- Initialize result
    result.descendant_states_to_enter := ARRAY[]::TEXT[];
    result.descendant_states_for_default_entry := ARRAY[]::TEXT[];
    
    -- Get the state record from database using state_path, fsm_name, and fsm_version
    SELECT * INTO state_record
    FROM fsm_core.fsm_states 
    WHERE computed_state_key_ltree = input_state_id::LTREE 
      AND fsm_name = fsm_name_param 
      AND fsm_version = fsm_version_param;

    RAISE NOTICE 'state_record.type: %', state_record.type;
    -- If state doesn't exist, return empty arrays
    IF state_record IS NULL THEN
        RETURN result;
    END IF;
    
    -- Process based on state type
    IF state_record.type = 'compound' THEN
        -- For compound states: add initial target and recurse with it
        IF state_record.initial IS NOT NULL AND state_record.initial->'target' IS NOT NULL THEN
            initial_state := state_record.initial->'target'->>0;
            RAISE NOTICE 'Initial state: %', initial_state;
            -- Sanitize initial_state
            sanitized_initial_state := fsm_core.sanitize_text_to_ltree(input_text := initial_state)::TEXT;
            SELECT computed_state_key_ltree INTO sanitized_initial_state_ltree
            FROM fsm_core.fsm_states
            WHERE computed_state_id_ltree = sanitized_initial_state::ltree;
            
            
            -- Add sanitized initial state to both arrays
            descendant_states_to_enter := array_append(descendant_states_to_enter, sanitized_initial_state_ltree::text);
            descendant_states_for_default_entry := array_append(descendant_states_for_default_entry, sanitized_initial_state_ltree::text);
            
            -- Recursive call with sanitized initial target and merge results
            child_result := fsm_core.get_descendant_states_for_entry_v1(input_state_id := sanitized_initial_state_ltree::text, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param);

            descendant_states_to_enter := array_cat(descendant_states_to_enter, child_result.descendant_states_to_enter);
            descendant_states_for_default_entry := array_cat(descendant_states_for_default_entry, child_result.descendant_states_for_default_entry);

            -- TODO: add all inbetween states nodes from target node and its' initial node
            -- addProperAncestorStatesToEnter(
            --     initialState,
            --     stateNode,
            --     statesToEnter,
            --     historyValue,
            --     statesForDefaultEntry
            -- );

            -- function addProperAncestorStatesToEnter(
            --     stateNode: AnyStateNode,
            --     toStateNode: AnyStateNode | undefined,
            --     statesToEnter: Set<AnyStateNode>,
            --     historyValue: HistoryValue<any, any>,
            --     statesForDefaultEntry: Set<AnyStateNode>
            --     ) {
            --         fsm_core.get_ancestor_states_for_entry_v1(
            --             statesToEnter,
            --             historyValue,
            --             statesForDefaultEntry,
            --             get_proper_ancestors(stateNode, toStateNode)
            --         );
            --     }

            ancestors := fsm_core.get_proper_ancestors(state_path_ltree := sanitized_initial_state_ltree::TEXT, to_state_path_ltree := state_record.computed_state_key_ltree::TEXT);
            ancestors_result := fsm_core.get_ancestor_states_for_entry_v1(
                ancestors := ancestors,
                reentrancy_domain := NULL,
                fsm_name_param := fsm_name_param,
                fsm_version_param := fsm_version_param
            );

            -- TODO: DIFF::  for  descendant_states_to_enter and descendant_states_for_default_entry
            descendant_states_to_enter := array_cat(descendant_states_to_enter, ancestors_result.ancestor_states_to_enter);
            

        END IF;
        
    ELSIF state_record.type = 'parallel' THEN
        -- For parallel states: recurse with all child states
        child_states := state_record.states;
        
        IF child_states IS NOT NULL THEN
            FOR child_state IN SELECT value FROM jsonb_each(child_states)
            LOOP
                child_id := child_state->>'id';
                
                -- Sanitize child_id
                sanitized_child_id := fsm_core.sanitize_text_to_ltree(input_text := child_id)::TEXT;
                SELECT computed_state_key_ltree INTO sanitized_child_id_ltree
                FROM fsm_core.fsm_states
                WHERE computed_state_id_ltree = sanitized_child_id::ltree;

                -- Add sanitized child state to both arrays
                descendant_states_to_enter := array_append(descendant_states_to_enter, sanitized_child_id_ltree::text);
                descendant_states_for_default_entry := array_append(descendant_states_for_default_entry, sanitized_child_id_ltree::text);
                
                -- Recursive call with sanitized child state and merge results
                child_result := fsm_core.get_descendant_states_for_entry_v1(input_state_id := sanitized_child_id_ltree::text, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param);
                descendant_states_to_enter := array_cat(descendant_states_to_enter, child_result.descendant_states_to_enter);
                descendant_states_for_default_entry := array_cat(descendant_states_for_default_entry, child_result.descendant_states_for_default_entry);
            END LOOP;
        END IF;
    ELSIF state_record.type = 'atomic' OR state_record.type = 'final' THEN
        -- For atomic, final no descendants to add
        -- DO NOTHING
        
    END IF;
   
    -- Remove duplicates from both arrays
    SELECT array_agg(DISTINCT state) INTO descendant_states_to_enter 
    FROM unnest(descendant_states_to_enter) AS state;
    
    SELECT array_agg(DISTINCT state) INTO descendant_states_for_default_entry 
    FROM unnest(descendant_states_for_default_entry) AS state;
    
    -- Set result values
    result.descendant_states_to_enter := COALESCE(descendant_states_to_enter, ARRAY[]::TEXT[]);
    result.descendant_states_for_default_entry := COALESCE(descendant_states_for_default_entry, ARRAY[]::TEXT[]);

    RAISE NOTICE 'fsm_core.get_descendant_states_for_entry_v1 result: %', result;
    RETURN result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.get_descendant_states_for_entry_v2(input_state_id text, fsm_name_param text, fsm_version_param text)
 RETURNS fsm_core.descendant_states_result_v2
 LANGUAGE plpgsql
AS $function$
DECLARE
    result fsm_core.descendant_states_result_v2;
    descendant_states_to_enter TEXT[] := ARRAY[]::TEXT[];
    descendant_states_for_default_entry TEXT[] := ARRAY[]::TEXT[];
    state_record fsm_core.fsm_states;
    child_states JSONB;
    child_state JSONB;
    child_id TEXT;
    sanitized_child_id TEXT;
    sanitized_child_id_ltree LTREE;
    initial_state TEXT;
    sanitized_initial_state TEXT;
    sanitized_initial_state_ltree LTREE;
    child_result fsm_core.descendant_states_result_v2;
    ancestors TEXT[];
    ancestors_result RECORD;
BEGIN
    -- Initialize result
    result.descendant_states_to_enter := ARRAY[]::TEXT[];
    result.descendant_states_for_default_entry := ARRAY[]::TEXT[];
    
    -- Get the state record from database using state_path, fsm_name, and fsm_version
    SELECT * INTO state_record
    FROM fsm_core.fsm_states 
    WHERE computed_state_key_ltree = input_state_id::LTREE 
      AND fsm_name = fsm_name_param 
      AND fsm_version = fsm_version_param;

    RAISE NOTICE 'state_record.type: %', state_record.type;
    -- If state doesn't exist, return empty arrays
    IF state_record IS NULL THEN
        RETURN result;
    END IF;
    
    -- Process based on state type
    IF state_record.type = 'compound' THEN
        -- For compound states: add initial target and recurse with it
        IF state_record.initial IS NOT NULL AND state_record.initial->'target' IS NOT NULL THEN
            initial_state := state_record.initial->'target'->>0;
            RAISE NOTICE 'Initial state: %', initial_state;
            -- Sanitize initial_state
            sanitized_initial_state := fsm_core.sanitize_text_to_ltree(input_text := initial_state)::TEXT;
            SELECT computed_state_key_ltree INTO sanitized_initial_state_ltree
            FROM fsm_core.fsm_states
            WHERE computed_state_id_ltree = sanitized_initial_state::ltree;
            
            
            -- Add sanitized initial state to both arrays
            descendant_states_to_enter := array_append(descendant_states_to_enter, sanitized_initial_state_ltree::text);
            descendant_states_for_default_entry := array_append(descendant_states_for_default_entry, sanitized_initial_state_ltree::text);
            
            -- Recursive call with sanitized initial target and merge results
            child_result := fsm_core.get_descendant_states_for_entry_v2(input_state_id := sanitized_initial_state_ltree::text, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param);

            descendant_states_to_enter := array_cat(descendant_states_to_enter, child_result.descendant_states_to_enter);
            descendant_states_for_default_entry := array_cat(descendant_states_for_default_entry, child_result.descendant_states_for_default_entry);

            -- TODO: add all inbetween states nodes from target node and its' initial node
            -- addProperAncestorStatesToEnter(
            --     initialState,
            --     stateNode,
            --     statesToEnter,
            --     historyValue,
            --     statesForDefaultEntry
            -- );

            -- function addProperAncestorStatesToEnter(
            --     stateNode: AnyStateNode,
            --     toStateNode: AnyStateNode | undefined,
            --     statesToEnter: Set<AnyStateNode>,
            --     historyValue: HistoryValue<any, any>,
            --     statesForDefaultEntry: Set<AnyStateNode>
            --     ) {
            --         fsm_core.get_ancestor_states_for_entry_v2(
            --             statesToEnter,
            --             historyValue,
            --             statesForDefaultEntry,
            --             get_proper_ancestors(stateNode, toStateNode)
            --         );
            --     }

            ancestors := fsm_core.get_proper_ancestors(state_path_ltree := sanitized_initial_state_ltree::TEXT, to_state_path_ltree := state_record.computed_state_key_ltree::TEXT);
            ancestors_result := fsm_core.get_ancestor_states_for_entry_v2(
                ancestors := ancestors,
                reentrancy_domain := NULL,
                fsm_name_param := fsm_name_param,
                fsm_version_param := fsm_version_param
            );

            -- TODO: DIFF::  for  descendant_states_to_enter and descendant_states_for_default_entry
            descendant_states_to_enter := array_cat(descendant_states_to_enter, ancestors_result.ancestor_states_to_enter);
            

        END IF;
        
    ELSIF state_record.type = 'parallel' THEN
        -- For parallel states: recurse with all child states
        child_states := state_record.states;
        
        IF child_states IS NOT NULL THEN
            FOR child_state IN SELECT value FROM jsonb_each(child_states)
            LOOP
                child_id := child_state->>'id';
                
                -- Sanitize child_id
                sanitized_child_id := fsm_core.sanitize_text_to_ltree(input_text := child_id)::TEXT;
                SELECT computed_state_key_ltree INTO sanitized_child_id_ltree
                FROM fsm_core.fsm_states
                WHERE computed_state_id_ltree = sanitized_child_id::ltree;

                -- Add sanitized child state to both arrays
                descendant_states_to_enter := array_append(descendant_states_to_enter, sanitized_child_id_ltree::text);
                descendant_states_for_default_entry := array_append(descendant_states_for_default_entry, sanitized_child_id_ltree::text);
                
                -- Recursive call with sanitized child state and merge results
                child_result := fsm_core.get_descendant_states_for_entry_v2(input_state_id := sanitized_child_id_ltree::text, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param);
                descendant_states_to_enter := array_cat(descendant_states_to_enter, child_result.descendant_states_to_enter);
                descendant_states_for_default_entry := array_cat(descendant_states_for_default_entry, child_result.descendant_states_for_default_entry);
            END LOOP;
        END IF;
    ELSIF state_record.type = 'atomic' OR state_record.type = 'final' THEN
        -- For atomic, final no descendants to add
        -- DO NOTHING
        
    END IF;
   
    -- Remove duplicates from both arrays
    SELECT array_agg(DISTINCT state) INTO descendant_states_to_enter 
    FROM unnest(descendant_states_to_enter) AS state;
    
    SELECT array_agg(DISTINCT state) INTO descendant_states_for_default_entry 
    FROM unnest(descendant_states_for_default_entry) AS state;
    
    -- Set result values
    result.descendant_states_to_enter := COALESCE(descendant_states_to_enter, ARRAY[]::TEXT[]);
    result.descendant_states_for_default_entry := COALESCE(descendant_states_for_default_entry, ARRAY[]::TEXT[]);

    RAISE NOTICE 'fsm_core.get_descendant_states_for_entry_v2 result: %', result;
    RETURN result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.get_entry_actions_v2(p_state_paths text[], p_fsm_name text, p_fsm_version text)
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
            COALESCE(fs.entry, '[]'::jsonb) AS entry_actions,
            COALESCE(fs.invoke, '[]'::jsonb) AS invoke_actions,
            fs.fsm_order,
            fs.fsm_name,
            fs.fsm_version
        FROM fsm_core.fsm_states fs
        WHERE 
            fs.computed_state_key_ltree = ANY(p_state_paths::ltree[])
            AND fs.fsm_name = p_fsm_name
            AND fs.fsm_version = p_fsm_version
        ORDER BY fs.fsm_order DESC
    LOOP
        -- Process entry actions and add to combined array
        IF jsonb_array_length(rec.entry_actions) > 0 THEN
            FOR i IN 0..jsonb_array_length(rec.entry_actions)-1 LOOP
                action := rec.entry_actions->i;
                action := action || jsonb_build_object(
                    'fsm_order', rec.fsm_order,
                    'action_type', 'entry',
                    'parentFsmName', rec.fsm_name,
                    'parentFsmVersion', rec.fsm_version
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
                    'action_type', 'invoke',
                    'parentFsmName', rec.fsm_name,
                    'parentFsmVersion', rec.fsm_version
                );
                all_actions := all_actions || jsonb_build_array(action);
            END LOOP;
        END IF;
    END LOOP;
    
    -- Return single JSON with combined actions array
    -- Actions are already sorted by fsm_order DESC due to the ORDER BY in the query
    -- RETURN jsonb_build_object('actions', all_actions);
    RETURN all_actions;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.get_fsm_data_resolve_state_value_v2(input_fsm_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    fi_record fsm_core.fsm_instance;
    resolved_value JSONB;
    result_json JSONB;
BEGIN
    RAISE NOTICE '[get_fsm_data_resolve_state_value_v2] Searching for fsm_instance with id=%', input_fsm_id;
    SELECT * INTO fi_record
    FROM fsm_core.fsm_instance
    WHERE id = input_fsm_id::uuid;

    IF fi_record IS NULL THEN
        RAISE EXCEPTION '[get_fsm_data_resolve_state_value_v2] No fsm_instance found for id=%', input_fsm_id;
    END IF;

    RAISE NOTICE '[get_fsm_data_resolve_state_value_v2] Found fsm_instance, calling resolve_state_value_v2...';
    resolved_value := fsm_core.resolve_state_value_v2(input_json := fi_record.fsm_instance_state, input_fsm_name := fi_record.fsm_name, input_fsm_version := fi_record.fsm_version);

    result_json := jsonb_build_object(
        'fsm_instance_row', to_jsonb(fi_record),
        'resolved_state_value', resolved_value
    );
    RETURN result_json;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.jsonb_all_paths(j jsonb, prefix text DEFAULT ''::text)
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
              result := result || fsm_core.jsonb_all_paths(j := rec.value, prefix := new_prefix);
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

CREATE OR REPLACE FUNCTION fsm_core.jsonb_deep_merge(a jsonb, b jsonb)
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
                        fsm_core.jsonb_deep_merge(a := aval, b := jsonb_build_object(scalar_key, NULL)),
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
                        fsm_core.jsonb_deep_merge(a := jsonb_build_object(scalar_key, NULL), b := bval),
                        true
                    );
                ELSE
                    merged := jsonb_set(
                        merged,
                        ARRAY[key_],
                        fsm_core.jsonb_deep_merge(a := aval, b := bval),
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

CREATE OR REPLACE FUNCTION fsm_core.load_fsm_state_from_json_v1(json_input jsonb, root_node_text text, input_fsm_name text, input_fsm_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    state_key TEXT;
    state_key_ltree LTREE;
    state_id TEXT;
    state_id_ltree LTREE;
    state_obj JSONB;
    root_key TEXT;
    prefix TEXT := input_fsm_name || '.' || input_fsm_version;
    total_calls INTEGER := 0; -- aggregate count of calls including recursion
    child_result JSONB;
    child_calls INTEGER;
    child_ok BOOLEAN;
BEGIN
    total_calls := 1; -- this invocation

    state_id_ltree := fsm_core.sanitize_text_to_ltree(input_text := json_input->>'id');
    state_key_ltree := fsm_core.sanitize_text_to_ltree(input_text := json_input->>'key');

    IF root_node_text IS NOT NULL THEN
        root_key := root_node_text || '.' || state_key_ltree::TEXT;
    ELSE
        root_key := state_key_ltree::TEXT;
    END IF;

    RAISE NOTICE 'Inserting state with root_key: %', root_key;

    -- 1. Insert root state with all columns
    INSERT INTO fsm_core.fsm_states (
        state_id_with_fsm_name_and_fsm_version, computed_state_id_ltree, computed_state_key_ltree, id, key, parent_node, type, description, fsm_order, context, states, initial, fsm_on, transitions, entry, exit, invoke, data, history, fsm_version, fsm_name
    ) VALUES (
        -- TODO: state_id_with_fsm_name_and_fsm_version can be combined with prefix.  root_key OR state_id_ltree
        -- (prefix || '.' || root_key)::ltree,
        prefix || '.' || state_id_ltree::TEXT,
        (state_id_ltree)::ltree,
        (root_key)::ltree,
        json_input->>'id',
        json_input->>'key',
        root_node_text, -- parent_node
        (json_input->>'type')::fsm_core.fsm_state_type,
        json_input->>'description',
        (json_input->>'order')::INTEGER,
        json_input->'context',
        json_input->'states',
        json_input->'initial',
        json_input->'on',
        json_input->'transitions',
        json_input->'entry',
        json_input->'exit',
        json_input->'invoke',
        json_input->'data',
        json_input->>'history',
        input_fsm_version,
        input_fsm_name
    )
    ON CONFLICT DO NOTHING;

    RAISE NOTICE 'invoke value: %', json_input->'invoke';

    -- 2. check for all invokes (assume invoke is always an array)
    IF json_input::jsonb ? 'invoke' THEN
        DECLARE
            inv_item JSONB;
            child_count INTEGER;
        BEGIN
            FOR inv_item IN SELECT value FROM jsonb_array_elements(json_input->'invoke')
            LOOP
                RAISE NOTICE 'Processing invoke item: %', inv_item;

                IF inv_item IS NOT NULL AND inv_item->>'fsmType' = 'fsm' THEN
                    RAISE NOTICE 'Found fsm invoke: %', inv_item;
                    -- Check if src (child FSM name) and fsmVersion exists
                    IF (inv_item->>'src') IS NOT NULL AND (inv_item->>'fsmVersion') IS NOT NULL THEN

                        SELECT COUNT(*) INTO child_count
                        FROM fsm_core.fsm_states
                        WHERE fsm_name = inv_item->>'src'
                        AND fsm_version = inv_item->>'fsmVersion';

                        IF child_count = 0 THEN -- NOT FOUND
                            RAISE EXCEPTION 'Child FSM not found in fsm_core.fsm_states: %, %', inv_item->>'src', inv_item->>'fsmVersion';
                        ELSE
                            RAISE NOTICE 'Child FSM found in fsm_core.fsm_states: %, % (count=%)', inv_item->>'src', inv_item->>'fsmVersion', child_count;
                        END IF;
                    ELSE
                        RAISE WARNING 'Missing src or fsmVersion in invoke item: %', inv_item;
                    END IF;
                END IF;

            END LOOP;
        END;
    ELSE
        RAISE NOTICE 'No invoke property present';
    END IF;

    -- 3. Insert all nested states with all columns and their transitions
    FOR state_key, state_obj IN
        SELECT key, value
        FROM jsonb_each(json_input->'states')
    LOOP
        -- Only call recursively if state_obj is not null
        IF state_obj IS NOT NULL THEN
            RAISE NOTICE 'Inserting nested state key: % and root_key: %', state_obj->>'id', root_key;
            -- Call recursively and capture result to aggregate counts and propagate errors
            child_result := fsm_core.load_fsm_state_from_json_v1(json_input := state_obj, root_node_text := root_key, input_fsm_name := input_fsm_name, input_fsm_version := input_fsm_version);
            -- If child_result is null (should not happen), raise an exception
            IF child_result IS NULL THEN
                RAISE EXCEPTION 'Child loader returned NULL for nested state % under %', state_obj->>'id', root_key;
            END IF;

            -- Extract child's calls and ok
            child_ok := COALESCE((child_result->>'ok')::BOOLEAN, false);
            child_calls := COALESCE((child_result->>'fsm_core.fsm_states_count')::INTEGER, 0);
            total_calls := total_calls + child_calls;

            IF NOT child_ok THEN
                -- Re-raise child error as an exception to propagate upward
                RAISE EXCEPTION 'Child loader error for nested state % under %: %', state_obj->>'id', root_key, COALESCE(child_result->>'error', child_result::TEXT);
            END IF;
        ELSE
            RAISE NOTICE 'Skipping state due to missing required fields: %', state_obj;
        END IF;
    END LOOP;

    -- Success: return ok true and count
    RETURN jsonb_build_object('ok', to_jsonb(true), 'fsm_core.fsm_states_count', to_jsonb(total_calls));

END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.load_fsm_state_from_json_v2(json_input jsonb, root_node_text text, input_fsm_name text, input_fsm_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    state_key TEXT;
    state_key_ltree LTREE;
    state_id TEXT;
    state_id_ltree LTREE;
    state_obj JSONB;
    root_key TEXT;
    prefix TEXT := input_fsm_name || '.' || input_fsm_version;
    total_calls INTEGER := 0; -- aggregate count of calls including recursion
    child_result JSONB;
    child_calls INTEGER;
    child_ok BOOLEAN;
BEGIN
    total_calls := 1; -- this invocation

    state_id_ltree := fsm_core.sanitize_text_to_ltree(input_text := json_input->>'id');
    state_key_ltree := fsm_core.sanitize_text_to_ltree(input_text := json_input->>'key');

    IF root_node_text IS NOT NULL THEN
        root_key := root_node_text || '.' || state_key_ltree::TEXT;
    ELSE
        root_key := state_key_ltree::TEXT;
    END IF;

    RAISE NOTICE 'Inserting state with root_key: %', root_key;

    -- 1. Insert root state with all columns
    INSERT INTO fsm_core.fsm_states (
        state_id_with_fsm_name_and_fsm_version, computed_state_id_ltree, computed_state_key_ltree, id, key, parent_node, type, description, fsm_order, context, states, initial, fsm_on, transitions, entry, exit, invoke, data, history, fsm_version, fsm_name
    ) VALUES (
        -- TODO: state_id_with_fsm_name_and_fsm_version can be combined with prefix.  root_key OR state_id_ltree
        -- (prefix || '.' || root_key)::ltree,
        prefix || '.' || state_id_ltree::TEXT,
        (state_id_ltree)::ltree,
        (root_key)::ltree,
        json_input->>'id',
        json_input->>'key',
        root_node_text, -- parent_node
        (json_input->>'type')::fsm_core.fsm_state_type,
        json_input->>'description',
        (json_input->>'order')::INTEGER,
        json_input->'context',
        json_input->'states',
        json_input->'initial',
        json_input->'on',
        json_input->'transitions',
        json_input->'entry',
        json_input->'exit',
        json_input->'invoke',
        json_input->'data',
        json_input->>'history',
        input_fsm_version,
        input_fsm_name
    )
    ON CONFLICT DO NOTHING;

    RAISE NOTICE 'invoke value: %', json_input->'invoke';

    -- 2. check for all invokes (assume invoke is always an array)
    IF json_input::jsonb ? 'invoke' THEN
        DECLARE
            inv_item JSONB;
            child_count INTEGER;
        BEGIN
            FOR inv_item IN SELECT value FROM jsonb_array_elements(json_input->'invoke')
            LOOP
                RAISE NOTICE 'Processing invoke item: %', inv_item;

                IF inv_item IS NOT NULL AND inv_item->>'fsmType' = 'fsm' THEN
                    RAISE NOTICE 'Found fsm invoke: %', inv_item;
                    -- Check if src (child FSM name) and fsmVersion exists
                    IF (inv_item->>'src') IS NOT NULL AND (inv_item->>'fsmVersion') IS NOT NULL THEN

                        SELECT COUNT(*) INTO child_count
                        FROM fsm_core.fsm_states
                        WHERE fsm_name = inv_item->>'src'
                        AND fsm_version = inv_item->>'fsmVersion';

                        IF child_count = 0 THEN -- NOT FOUND
                            RAISE EXCEPTION 'Child FSM not found in fsm_core.fsm_states: %, %', inv_item->>'src', inv_item->>'fsmVersion';
                        ELSE
                            RAISE NOTICE 'Child FSM found in fsm_core.fsm_states: %, % (count=%)', inv_item->>'src', inv_item->>'fsmVersion', child_count;
                        END IF;
                    ELSE
                        RAISE WARNING 'Missing src or fsmVersion in invoke item: %', inv_item;
                    END IF;
                END IF;

            END LOOP;
        END;
    ELSE
        RAISE NOTICE 'No invoke property present';
    END IF;

    -- 3. Insert all nested states with all columns and their transitions
    FOR state_key, state_obj IN
        SELECT key, value
        FROM jsonb_each(json_input->'states')
    LOOP
        -- Only call recursively if state_obj is not null
        IF state_obj IS NOT NULL THEN
            RAISE NOTICE 'Inserting nested state key: % and root_key: %', state_obj->>'id', root_key;
            -- Call recursively and capture result to aggregate counts and propagate errors
            child_result := fsm_core.load_fsm_state_from_json_v2(json_input := state_obj, root_node_text := root_key, input_fsm_name := input_fsm_name, input_fsm_version := input_fsm_version);
            -- If child_result is null (should not happen), raise an exception
            IF child_result IS NULL THEN
                RAISE EXCEPTION 'Child loader returned NULL for nested state % under %', state_obj->>'id', root_key;
            END IF;

            -- Extract child's calls and ok
            child_ok := COALESCE((child_result->>'ok')::BOOLEAN, false);
            child_calls := COALESCE((child_result->>'fsm_core.fsm_states_count')::INTEGER, 0);
            total_calls := total_calls + child_calls;

            IF NOT child_ok THEN
                -- Re-raise child error as an exception to propagate upward
                RAISE EXCEPTION 'Child loader error for nested state % under %: %', state_obj->>'id', root_key, COALESCE(child_result->>'error', child_result::TEXT);
            END IF;
        ELSE
            RAISE NOTICE 'Skipping state due to missing required fields: %', state_obj;
        END IF;
    END LOOP;

    -- Success: return ok true and count
    RETURN jsonb_build_object('ok', to_jsonb(true), 'fsm_core.fsm_states_count', to_jsonb(total_calls));

END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.load_fsm_transition_from_json_v1(json_input jsonb, root_node_text text, fsm_name text, fsm_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    state_key TEXT;
    state_key_ltree LTREE;
    state_id TEXT;
    state_id_ltree LTREE;
    state_obj JSONB;
    transition JSONB;
    transition_array JSONB[];
    source TEXT;
    sanitized_source LTREE;
    sanitized_source_ltree LTREE;
    target_array TEXT[];
    sanitized_target_array LTREE[];
    sanitized_target_ltree_array LTREE[];
    event_type TEXT;
    actions JSONB;
    cond JSONB;
    reenter BOOLEAN;
    transition_domain_lca ltree;
    root_key TEXT;
    prefix TEXT := fsm_name || '.' || fsm_version;
    total_calls INTEGER := 0;
    child_result JSONB;
    child_calls INTEGER;
    child_ok BOOLEAN;
BEGIN
    
    total_calls := 1; -- this invocation
    state_id_ltree := fsm_core.sanitize_text_to_ltree(input_text := json_input->>'id');
    state_key_ltree := fsm_core.sanitize_text_to_ltree(input_text := json_input->>'key');

    IF root_node_text IS NOT NULL THEN
        root_key := root_node_text || '.' || state_key_ltree::TEXT;
    ELSE
        root_key := state_key_ltree::TEXT;
    END IF;


    RAISE NOTICE 'Inserting state with root_key: %', root_key;


    -- 1. Top-level transitions
    IF json_input::jsonb ? 'transitions' THEN
        SELECT ARRAY_AGG(value) INTO transition_array
        FROM jsonb_array_elements(json_input->'transitions');

        IF transition_array IS NOT NULL THEN
            FOREACH transition IN ARRAY transition_array
                LOOP
                    -- Clean source
                    source := transition->>'source';
                    -- TODO:TBD:: fsm_core.sanitize_text_to_ltree or remove_hashtag_from_text
                    RAISE NOTICE 'sanitized source by using fsm_core.sanitize_text_to_ltree or remove_hashtag_from_text';
                    sanitized_source := fsm_core.sanitize_text_to_ltree(input_text := source);

                    SELECT computed_state_key_ltree INTO sanitized_source_ltree
                    FROM fsm_core.fsm_states
                    WHERE computed_state_id_ltree = sanitized_source;
                    RAISE NOTICE 'sanitized_source_ltree: %', sanitized_source_ltree;

                    SELECT ARRAY(
                            SELECT jsonb_array_elements_text(transition->'target')
                    ) INTO target_array;

                    RAISE NOTICE 'target_array: %', target_array;
                    -- Sanitize target array
                    IF target_array IS NULL THEN
                        sanitized_target_array := ARRAY[]::ltree[];
                    ELSE
                        sanitized_target_array := fsm_core.sanitize_text_array_to_ltree_array(input_array := target_array);
                    END IF;


                    SELECT ARRAY(
                            SELECT computed_state_key_ltree
                            FROM fsm_core.fsm_states
                            WHERE computed_state_id_ltree = ANY(sanitized_target_array)
                    ) INTO sanitized_target_ltree_array;

                    RAISE NOTICE 'sanitized_target_array: %', sanitized_target_ltree_array;

                    event_type := transition->>'eventType';
                    -- Get actions and cond
                    actions := transition->'actions';
                    cond := transition->'cond';

                    -- Get reenter flag (may be null)
                    IF (transition::jsonb ? 'reenter') THEN
                        reenter := (transition->>'reenter')::boolean;
                    ELSE
                        reenter := NULL;
                    END IF;
    
                   -- Use already sanitized target array in transition_domain_lca in v2

                    INSERT INTO fsm_core.fsm_transitions (
                        source, computed_sanitized_source_ltree, target, computed_sanitized_target_ltree_array, event_type, actions, cond, computed_transition_domain_lca,
                                            reenter, fsm_name, fsm_version
                    )
                                    VALUES (source, sanitized_source_ltree, target_array, sanitized_target_ltree_array, event_type, actions, cond, null, reenter, fsm_name, fsm_version);
                
                    RAISE NOTICE 'Inserted top-level transition: source=%, target=%, event_type=%', source, target_array, event_type;  
                
            END LOOP;
        END IF;
    END IF;

    -- 3. Insert all nested states with all columns and their transitions
    FOR state_key, state_obj IN
        SELECT key, value
        FROM jsonb_each(json_input->'states')
    LOOP
        -- Only call recursively if state_obj is not null and has required fields
        -- IF state_obj IS NOT NULL AND state_obj->>'id' IS NOT NULL AND state_obj->>'key' IS NOT NULL AND state_obj->>'type' IS NOT NULL THEN
        IF state_obj IS NOT NULL THEN
            RAISE NOTICE 'Inserting nested state key: % and root_key: %', state_obj->>'id', root_key;
            -- Call recursively and capture result to aggregate counts and propagate errors
            child_result := fsm_core.load_fsm_transition_from_json_v1(json_input := state_obj, root_node_text := root_key, fsm_name := fsm_name, fsm_version := fsm_version);
            IF child_result IS NULL THEN
                RAISE EXCEPTION 'Child transition loader returned NULL for nested state % under %', state_obj->>'id', root_key;
            END IF;

            child_ok := COALESCE((child_result->>'ok')::BOOLEAN, false);
            child_calls := COALESCE((child_result->>'fsm_core.fsm_transitions_count')::INTEGER, 0);
            total_calls := total_calls + child_calls;

            IF NOT child_ok THEN
                RAISE EXCEPTION 'Child transition loader error for nested state % under %: %', state_obj->>'id', root_key, COALESCE(child_result->>'error', child_result::TEXT);
            END IF;
        ELSE
            RAISE NOTICE 'Skipping state due to missing required fields: %', state_obj;
        END IF;
    END LOOP;

    -- Success: return ok true and count
    RETURN jsonb_build_object('ok', to_jsonb(true), 'fsm_core.fsm_transitions_count', to_jsonb(total_calls));

END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.load_fsm_transition_from_json_v2(json_input jsonb, root_node_text text, fsm_name text, fsm_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    state_key TEXT;
    state_key_ltree LTREE;
    state_id TEXT;
    state_id_ltree LTREE;
    state_obj JSONB;
    transition JSONB;
    transition_array JSONB[];
    source TEXT;
    sanitized_source LTREE;
    sanitized_source_ltree LTREE;
    target_array TEXT[];
    sanitized_target_array LTREE[];
    sanitized_target_ltree_array LTREE[];
    event_type TEXT;
    actions JSONB;
    cond JSONB;
    reenter BOOLEAN;
    transition_domain_lca ltree;
    root_key TEXT;
    prefix TEXT := fsm_name || '.' || fsm_version;
    total_calls INTEGER := 0;
    child_result JSONB;
    child_calls INTEGER;
    child_ok BOOLEAN;
BEGIN
    
    total_calls := 1; -- this invocation
    state_id_ltree := fsm_core.sanitize_text_to_ltree(input_text := json_input->>'id');
    state_key_ltree := fsm_core.sanitize_text_to_ltree(input_text := json_input->>'key');

    IF root_node_text IS NOT NULL THEN
        root_key := root_node_text || '.' || state_key_ltree::TEXT;
    ELSE
        root_key := state_key_ltree::TEXT;
    END IF;


    RAISE NOTICE 'Inserting state with root_key: %', root_key;


    -- 1. Top-level transitions
    IF json_input::jsonb ? 'transitions' THEN
        SELECT ARRAY_AGG(value) INTO transition_array
        FROM jsonb_array_elements(json_input->'transitions');

        IF transition_array IS NOT NULL THEN
            FOREACH transition IN ARRAY transition_array
                LOOP
                    -- Clean source
                    source := transition->>'source';
                    -- TODO:TBD:: fsm_core.sanitize_text_to_ltree or remove_hashtag_from_text
                    RAISE NOTICE 'sanitized source by using fsm_core.sanitize_text_to_ltree or remove_hashtag_from_text';
                    sanitized_source := fsm_core.sanitize_text_to_ltree(input_text := source);

                    SELECT computed_state_key_ltree INTO sanitized_source_ltree
                    FROM fsm_core.fsm_states
                    WHERE computed_state_id_ltree = sanitized_source;
                    RAISE NOTICE 'sanitized_source_ltree: %', sanitized_source_ltree;

                    SELECT ARRAY(
                            SELECT jsonb_array_elements_text(transition->'target')
                    ) INTO target_array;

                    RAISE NOTICE 'target_array: %', target_array;
                    -- Sanitize target array
                    IF target_array IS NULL THEN
                        sanitized_target_array := ARRAY[]::ltree[];
                    ELSE
                        sanitized_target_array := fsm_core.sanitize_text_array_to_ltree_array(input_array := target_array);
                    END IF;


                    SELECT ARRAY(
                            SELECT computed_state_key_ltree
                            FROM fsm_core.fsm_states
                            WHERE computed_state_id_ltree = ANY(sanitized_target_array)
                    ) INTO sanitized_target_ltree_array;

                    RAISE NOTICE 'sanitized_target_array: %', sanitized_target_ltree_array;

                    event_type := transition->>'eventType';
                    -- Get actions and cond
                    actions := transition->'actions';
                    cond := transition->'cond';

                    -- Get reenter flag (may be null)
                    IF (transition::jsonb ? 'reenter') THEN
                        reenter := (transition->>'reenter')::boolean;
                    ELSE
                        reenter := NULL;
                    END IF;
    
                    -- Use already sanitized target array in transition_domain_lca in v2
                    transition_domain_lca := fsm_core.sql_lca_from_array(
                        paths := ARRAY[sanitized_source_ltree::ltree] || sanitized_target_ltree_array
                    );

                    RAISE NOTICE 'transition_domain_lca: %', transition_domain_lca;
                    -- If LCA calculation returned NULL, fall back to the root label of source (first path element)
                    IF transition_domain_lca::TEXT IS NULL THEN
                        BEGIN
                            -- subpath(...,0,1) returns the root/top-most label of the ltree
                            transition_domain_lca := subpath(sanitized_source_ltree, 0, 1);
                            RAISE NOTICE 'Fallback transition_domain_lca with subpath %', transition_domain_lca;
                        EXCEPTION WHEN OTHERS THEN
                            -- leave as NULL if source isn't a valid ltree
                            RAISE NOTICE 'Error in fallback transition_domain_lca calculation: %', SQLERRM;
                            transition_domain_lca := NULL;
                        END;
                    END IF;

                    INSERT INTO fsm_core.fsm_transitions (
                        source, computed_sanitized_source_ltree, target, computed_sanitized_target_ltree_array, event_type, actions, cond, computed_transition_domain_lca,
                                            reenter, fsm_name, fsm_version
                    )
                                    VALUES (source, sanitized_source_ltree, target_array, sanitized_target_ltree_array, event_type, actions, cond, transition_domain_lca, reenter, fsm_name, fsm_version);
                
                    RAISE NOTICE 'Inserted top-level transition: source=%, target=%, event_type=%', source, target_array, event_type;  
                
            END LOOP;
        END IF;
    END IF;

    -- 3. Insert all nested states with all columns and their transitions
    FOR state_key, state_obj IN
        SELECT key, value
        FROM jsonb_each(json_input->'states')
    LOOP
        -- Only call recursively if state_obj is not null and has required fields
        -- IF state_obj IS NOT NULL AND state_obj->>'id' IS NOT NULL AND state_obj->>'key' IS NOT NULL AND state_obj->>'type' IS NOT NULL THEN
        IF state_obj IS NOT NULL THEN
            RAISE NOTICE 'Inserting nested state key: % and root_key: %', state_obj->>'id', root_key;
            -- Call recursively and capture result to aggregate counts and propagate errors
            child_result := fsm_core.load_fsm_transition_from_json_v2(json_input := state_obj, root_node_text := root_key, fsm_name := fsm_name, fsm_version := fsm_version);
            IF child_result IS NULL THEN
                RAISE EXCEPTION 'Child transition loader returned NULL for nested state % under %', state_obj->>'id', root_key;
            END IF;

            child_ok := COALESCE((child_result->>'ok')::BOOLEAN, false);
            child_calls := COALESCE((child_result->>'fsm_core.fsm_transitions_count')::INTEGER, 0);
            total_calls := total_calls + child_calls;

            IF NOT child_ok THEN
                RAISE EXCEPTION 'Child transition loader error for nested state % under %: %', state_obj->>'id', root_key, COALESCE(child_result->>'error', child_result::TEXT);
            END IF;
        ELSE
            RAISE NOTICE 'Skipping state due to missing required fields: %', state_obj;
        END IF;
    END LOOP;

    -- Success: return ok true and count
    RETURN jsonb_build_object('ok', to_jsonb(true), 'fsm_core.fsm_transitions_count', to_jsonb(total_calls));

END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.macrostep_v1(event_name text, p_state_value text[], fsm_name_param text, fsm_version_param text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
	
	transition_record fsm_core.fsm_transitions;
    all_transition_records fsm_core.fsm_transitions[];
	guard_eval_transition_records fsm_core.fsm_transitions[];
	
	microstep_result JSONB;
BEGIN
	RAISE NOTICE 'fsm_core.macrostep_v1 called with event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;

	IF event_name = 'initialTransition_event' THEN
		RAISE NOTICE 'Initial transition event, skipping fsm_core.select_all_transitions_v1 and guard evaluation, directly calling fsm_core.microstep_v1 with empty transition_record';
		transition_record := NULL; -- or you can create a dummy transition_record with necessary fields for initial transition
	ELSE
		RAISE NOTICE 'Non-initial transition event, selecting all transitions and performing guard evaluation';
		SELECT array_agg(t) INTO all_transition_records
		FROM (
			SELECT (jsonb_populate_record(NULL::fsm_core.fsm_transitions, elem))::fsm_core.fsm_transitions AS t
			FROM jsonb_array_elements(fsm_core.select_all_transitions_v1(event_name := event_name, p_state_value := p_state_value, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param)) elem
		) sub;

		RAISE NOTICE 'Number of transition_records found: %', array_length(all_transition_records, 1);

		IF all_transition_records IS NULL OR array_length(all_transition_records, 1) IS NULL THEN
			
			RAISE EXCEPTION 'No valid transitions found for event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;
		
		ELSIF array_length(all_transition_records, 1) > 1 THEN
			
			RAISE NOTICE 'Number of transition_records found: %', array_length(all_transition_records, 1);
			
			-- method 1: temp solution
			-- RAISE NOTICE 'SKIP : Evaluating guard : Selecting the first transition_record without guard evaluation for fsm_core.microstep_v1, this is a temporary solution and should be replaced with proper guard evaluation and conflict resolution strategy';  
			-- transition_record := all_transition_records[1];

			-- method 2: call Evaluate guard conditions again in SQL to find the valid transition record, if multiple records are still valid after evaluation, raise exception
			RAISE NOTICE 'RUN : Evaluating guard : conditions for all transition_records in SQL to find the valid transition record';
			SELECT array_agg(t) INTO guard_eval_transition_records
				FROM fsm_core.select_transitions_with_guard_eval_v1(input_all_transitions := all_transition_records) t;

			RAISE NOTICE 'Number of transition_records after guard evaluation: %', array_length(guard_eval_transition_records, 1);
			IF guard_eval_transition_records IS NULL OR array_length(guard_eval_transition_records, 1) IS NULL THEN
				RAISE EXCEPTION 'No valid transitions found after guard evaluation for event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;
			ELSIF array_length(guard_eval_transition_records, 1) > 1 THEN
				RAISE NOTICE 'removeConflictingTransitions needed to resolve multiple transitions after guard evaluation for event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;
				-- In real implementation, we should have a conflict resolution strategy to select one transition record among multiple valid records, here we are just raising exception for demonstration purpose

				
				RAISE EXCEPTION 'Multiple valid transitions found after guard evaluation for event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;
			ELSIF array_length(guard_eval_transition_records, 1) = 1 THEN
				RAISE NOTICE 'One transition_record found after guard evaluation, selecting it for fsm_core.microstep_v1';
				transition_record := guard_eval_transition_records[1];
				RAISE NOTICE 'Selected transition_record: %', transition_record;

			END IF;

		ELSIF array_length(all_transition_records, 1) = 1 THEN

			RAISE NOTICE 'One transition_record found, selecting it for fsm_core.microstep_v1';
			transition_record := all_transition_records[1];
			RAISE NOTICE 'Selected transition_record: %', transition_record;	

		END IF;

		

	END IF;
	

	-- Call fsm_core.microstep_v1 and return its JSONB result
	microstep_result := fsm_core.microstep_v1(
		transition_record := transition_record,
		event_name := event_name,
		state_value_node_set := p_state_value,
		fsm_name_param := fsm_name_param,
		fsm_version_param := fsm_version_param
	);

	RAISE NOTICE 'microstep_result: %', microstep_result;

	RETURN microstep_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.macrostep_v2(event_name text, p_state_value text[], fsm_name_param text, fsm_version_param text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
	
	transition_record fsm_core.fsm_transitions;
    all_transition_records fsm_core.fsm_transitions[];
	guard_eval_transition_records fsm_core.fsm_transitions[];
	
	microstep_result JSONB;
BEGIN
	RAISE NOTICE 'fsm_core.macrostep_v2 called with event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;

	IF event_name = 'initialTransition_event' THEN
		RAISE NOTICE 'Initial transition event, skipping fsm_core.select_all_transitions_v2 and guard evaluation, directly calling fsm_core.microstep_v2 with empty transition_record';
		transition_record := NULL; -- or you can create a dummy transition_record with necessary fields for initial transition
	ELSE
		RAISE NOTICE 'Non-initial transition event, selecting all transitions and performing guard evaluation';
		SELECT array_agg(t) INTO all_transition_records
		FROM (
			SELECT (jsonb_populate_record(NULL::fsm_core.fsm_transitions, elem))::fsm_core.fsm_transitions AS t
			FROM jsonb_array_elements(fsm_core.select_all_transitions_v2(event_name := event_name, p_state_value := p_state_value, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param)) elem
		) sub;

		RAISE NOTICE 'Number of transition_records found: %', array_length(all_transition_records, 1);

		IF all_transition_records IS NULL OR array_length(all_transition_records, 1) IS NULL THEN
			
			RAISE EXCEPTION 'No valid transitions found for event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;
		
		ELSIF array_length(all_transition_records, 1) > 1 THEN
			
			RAISE NOTICE 'Number of transition_records found: %', array_length(all_transition_records, 1);
			
			-- method 1: temp solution
			-- RAISE NOTICE 'SKIP : Evaluating guard : Selecting the first transition_record without guard evaluation for fsm_core.microstep_v2, this is a temporary solution and should be replaced with proper guard evaluation and conflict resolution strategy';  
			-- transition_record := all_transition_records[1];

			-- method 2: call Evaluate guard conditions again in SQL to find the valid transition record, if multiple records are still valid after evaluation, raise exception
			RAISE NOTICE 'RUN : Evaluating guard : conditions for all transition_records in SQL to find the valid transition record';
			SELECT array_agg(t) INTO guard_eval_transition_records
				FROM fsm_core.select_transitions_with_guard_eval_v2(input_all_transitions := all_transition_records) t;

			RAISE NOTICE 'Number of transition_records after guard evaluation: %', array_length(guard_eval_transition_records, 1);
			IF guard_eval_transition_records IS NULL OR array_length(guard_eval_transition_records, 1) IS NULL THEN
				RAISE EXCEPTION 'No valid transitions found after guard evaluation for event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;
			ELSIF array_length(guard_eval_transition_records, 1) > 1 THEN
				RAISE NOTICE 'removeConflictingTransitions needed to resolve multiple transitions after guard evaluation for event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;
				-- In real implementation, we should have a conflict resolution strategy to select one transition record among multiple valid records, here we are just raising exception for demonstration purpose

				
				RAISE EXCEPTION 'Multiple valid transitions found after guard evaluation for event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;
			ELSIF array_length(guard_eval_transition_records, 1) = 1 THEN
				RAISE NOTICE 'One transition_record found after guard evaluation, selecting it for fsm_core.microstep_v2';
				transition_record := guard_eval_transition_records[1];
				RAISE NOTICE 'Selected transition_record: %', transition_record;

			END IF;

		ELSIF array_length(all_transition_records, 1) = 1 THEN

			RAISE NOTICE 'One transition_record found, selecting it for fsm_core.microstep_v2';
			transition_record := all_transition_records[1];
			RAISE NOTICE 'Selected transition_record: %', transition_record;	

		END IF;

		

	END IF;
	

	-- Call fsm_core.microstep_v2 and return its JSONB result
	microstep_result := fsm_core.microstep_v2(
		transition_record := transition_record,
		event_name := event_name,
		state_value_node_set := p_state_value,
		fsm_name_param := fsm_name_param,
		fsm_version_param := fsm_version_param
	);

	RAISE NOTICE 'microstep_result: %', microstep_result;

	RETURN microstep_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.microstep_v1(transition_record fsm_core.fsm_transitions, event_name text, state_value_node_set text[], fsm_name_param text, fsm_version_param text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
	
	transition_actions JSONB;
	exit_result JSONB;
	entry_result JSONB;
	exit_nodes TEXT[];
	entry_nodes TEXT[];
	updated_state_nodes TEXT[];
	updated_state_nodes_jsonb JSONB;
	exit_actions JSONB;
	entry_actions JSONB;
	initial_actions JSONB;
	result JSONB;
BEGIN
	RAISE NOTICE 'fsm_core.microstep_v1 called with event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;
	
	RAISE NOTICE 'state_value_node_set: %', state_value_node_set;


	-- 1. Call processEventTransitionForExit
	exit_result := fsm_core.compute_exit_actions_v1(transition_record := transition_record, p_state_node_set := state_value_node_set, p_fsm_name := transition_record.fsm_name, p_fsm_version := transition_record.fsm_version);
	RAISE NOTICE 'exit_result: %', exit_result;
	SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[]) INTO exit_nodes
	FROM jsonb_array_elements_text(COALESCE(exit_result->'exit_nodes', '[]'::jsonb));
	RAISE NOTICE 'exit_nodes: %', exit_nodes;


	-- 2. transition_actions
	transition_actions := transition_record.actions;
	RAISE NOTICE 'transition_actions: %', transition_actions; 

	-- 3. Call fsm_core.compute_entry_actions_v1
	-- if event is initialTransition_event, set is_initial_transition to TRUE
	IF event_name = 'initialTransition_event' THEN
		entry_result := fsm_core.compute_entry_actions_v1(transition_record := transition_record, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param, is_initial_transition := TRUE);
	ELSE
		entry_result := fsm_core.compute_entry_actions_v1(transition_record := transition_record, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param, is_initial_transition := FALSE);
	END IF;
	RAISE NOTICE 'entry_result: %', entry_result;
	SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[]) INTO entry_nodes
	FROM jsonb_array_elements_text(COALESCE(entry_result->'states_to_enter', '[]'::jsonb));
	RAISE NOTICE 'entry_nodes: %', entry_nodes;
	

	-- 4. Compute updated state node set:
	--    (state_value_node_set - exit_nodes) + entry_nodes
	updated_state_nodes := ARRAY(
		SELECT DISTINCT x FROM (
			SELECT unnest(state_value_node_set) AS x
			EXCEPT
			SELECT unnest(exit_nodes) AS x
			UNION
			SELECT unnest(entry_nodes) AS x
		) t
	);
	RAISE NOTICE 'updated_state_nodes: %', updated_state_nodes;

	
	updated_state_nodes_jsonb := fsm_core.build_nested_json_recursive(paths := updated_state_nodes);
	RAISE NOTICE 'updated_state_nodes_jsonb: %', updated_state_nodes_jsonb;

	-- 5. Return result as JSONB
	result := jsonb_build_object(
		'updated_state_value_node_set', updated_state_nodes,
		'updated_state_value', updated_state_nodes_jsonb,
		'exit_actions', exit_result->'exit_actions',
		'entry_actions', entry_result->'entry_actions_for_states_to_enter',
		'initial_actions', entry_result->'initial_actions_for_common_states',
		'transition_actions', transition_actions
	);
	RAISE NOTICE 'fsm_core.microstep_v1 result: %', result;
	RETURN result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.microstep_v2(transition_record fsm_core.fsm_transitions, event_name text, state_value_node_set text[], fsm_name_param text, fsm_version_param text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
	
	transition_actions JSONB;
	exit_result JSONB;
	entry_result JSONB;
	exit_nodes TEXT[];
	entry_nodes TEXT[];
	updated_state_nodes TEXT[];
	updated_state_nodes_jsonb JSONB;
	exit_actions JSONB;
	entry_actions JSONB;
	initial_actions JSONB;
	result_json JSONB;
BEGIN
	RAISE NOTICE 'fsm_core.microstep_v2 called with event_name=%, fsm_name=%, fsm_version=%', event_name, fsm_name_param, fsm_version_param;
	
	RAISE NOTICE 'state_value_node_set: %', state_value_node_set;


	-- 1. Call processEventTransitionForExit
	exit_result := fsm_core.compute_exit_actions_v2(transition_record := transition_record, p_state_node_set := state_value_node_set, p_fsm_name := transition_record.fsm_name, p_fsm_version := transition_record.fsm_version);
	RAISE NOTICE 'exit_result: %', exit_result;
	SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[]) INTO exit_nodes
	FROM jsonb_array_elements_text(COALESCE(exit_result->'exit_nodes', '[]'::jsonb));
	RAISE NOTICE 'exit_nodes: %', exit_nodes;


	-- 2. transition_actions
	transition_actions := transition_record.actions;
	RAISE NOTICE 'transition_actions: %', transition_actions; 

	-- 3. Call fsm_core.compute_entry_actions_v2
	-- if event is initialTransition_event, set is_initial_transition to TRUE
	IF event_name = 'initialTransition_event' THEN
		entry_result := fsm_core.compute_entry_actions_v2(transition_record := transition_record, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param, is_initial_transition := TRUE);
	ELSE
		entry_result := fsm_core.compute_entry_actions_v2(transition_record := transition_record, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param, is_initial_transition := FALSE);
	END IF;
	RAISE NOTICE 'entry_result: %', entry_result;
	SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[]) INTO entry_nodes
	FROM jsonb_array_elements_text(COALESCE(entry_result->'states_to_enter', '[]'::jsonb));
	RAISE NOTICE 'entry_nodes: %', entry_nodes;
	

	-- 4. Compute updated state node set:
	--    (state_value_node_set - exit_nodes) + entry_nodes
	updated_state_nodes := ARRAY(
		SELECT DISTINCT x FROM (
			SELECT unnest(state_value_node_set) AS x
			EXCEPT
			SELECT unnest(exit_nodes) AS x
			UNION
			SELECT unnest(entry_nodes) AS x
		) t
	);
	RAISE NOTICE 'updated_state_nodes: %', updated_state_nodes;

	
	updated_state_nodes_jsonb := fsm_core.build_nested_json_recursive(paths := updated_state_nodes);
	RAISE NOTICE 'updated_state_nodes_jsonb: %', updated_state_nodes_jsonb;

	-- 5. Return result as JSONB
	result_json := jsonb_build_object(
		'updated_state_value_node_set', updated_state_nodes,
		'updated_state_value', updated_state_nodes_jsonb,
		'exit_actions', exit_result->'exit_actions',
		'entry_actions', entry_result->'entry_actions_for_states_to_enter',
		'initial_actions', entry_result->'initial_actions_for_common_states',
		'transition_actions', transition_actions
	);
	RAISE NOTICE 'fsm_core.microstep_v2 result: %', result_json;
	RETURN result_json;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.path_string_to_jsonb(path text)
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
    RETURN jsonb_build_object(parts[1], fsm_core.path_string_to_jsonb(path := array_to_string(parts[2:], '.')));
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.purge_queue(queue_name text)
 RETURNS SETOF bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY
  SELECT * FROM pgmq.purge_queue(queue_name := queue_name);
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.resolve_state_value_v1(input_json jsonb, input_fsm_name text, input_fsm_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
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
    all_nodes := fsm_core.fsm_get_all_state_nodes_v1(p_state_paths := all_paths, p_fsm_name := input_fsm_name, p_fsm_version := input_fsm_version);

    RAISE NOTICE 'All nodes after fsm_core.fsm_get_all_state_nodes_v1: %', all_nodes;
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
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.resolve_state_value_v2(input_json jsonb, input_fsm_name text, input_fsm_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.sanitize_text_array_to_ltree_array(input_array text[])
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
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.sanitize_text_array_to_ltree_text_array(input_array text[])
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
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.test_event_transition_for_entry_v1(event_name text, fsm_name_param text, fsm_version_param text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    transition_record fsm_core.fsm_transitions;
    result JSONB;
BEGIN
    -- Find single record from fsm_core.fsm_transitions based on event_type, fsm_name, and fsm_version
    SELECT * INTO transition_record
    FROM fsm_core.fsm_transitions 
    WHERE event_type = event_name 
      AND fsm_name = fsm_name_param 
      AND fsm_version = fsm_version_param
    LIMIT 1;
    
    -- if event_name = "initialTransition_event" then set is_initial_transition = TRUE
    -- and call fsm_core.compute_entry_actions_v1 with is_initial_transition = TRUE
    -- else call with FALSE
    IF event_name = 'initialTransition_event' THEN
        SELECT fsm_core.compute_entry_actions_v1(transition_record := transition_record, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param, is_initial_transition := TRUE) INTO result;
    ELSE
        SELECT fsm_core.compute_entry_actions_v1(transition_record := transition_record, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param, is_initial_transition := FALSE) INTO result;
    END IF;


    RETURN result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.test_event_transition_for_entry_v2(event_name text, fsm_name_param text, fsm_version_param text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    transition_record fsm_core.fsm_transitions;
    result JSONB;
BEGIN
    -- Find single record from fsm_core.fsm_transitions based on event_type, fsm_name, and fsm_version
    SELECT * INTO transition_record
    FROM fsm_core.fsm_transitions 
    WHERE event_type = event_name 
      AND fsm_name = fsm_name_param 
      AND fsm_version = fsm_version_param
    LIMIT 1;
    
    -- if event_name = "initialTransition_event" then set is_initial_transition = TRUE
    -- and call fsm_core.compute_entry_actions_v2 with is_initial_transition = TRUE
    -- else call with FALSE
    IF event_name = 'initialTransition_event' THEN
        SELECT fsm_core.compute_entry_actions_v2(transition_record := transition_record, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param, is_initial_transition := TRUE) INTO result;
    ELSE
        SELECT fsm_core.compute_entry_actions_v2(transition_record := transition_record, fsm_name_param := fsm_name_param, fsm_version_param := fsm_version_param, is_initial_transition := FALSE) INTO result;
    END IF;


    RETURN result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.test_jsonb_roundtrip(input_jsonb jsonb)
 RETURNS TABLE(original jsonb, reconstructed jsonb, paths text[])
 LANGUAGE plpgsql
AS $function$
DECLARE
    extracted_paths TEXT[];
    rebuilt_jsonb JSONB;
BEGIN
    extracted_paths := fsm_core.jsonb_all_paths(j := input_jsonb, prefix := '');
    rebuilt_jsonb := fsm_core.build_nested_json_recursive(paths := extracted_paths);
    RETURN QUERY SELECT input_jsonb, rebuilt_jsonb, extracted_paths;
END;
$function$
;


set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.purge_queue(queue_name text)
 RETURNS SETOF bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY
  SELECT * FROM pgmq.purge_queue(queue_name := queue_name);
END;
$function$
;

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


    SELECT fsm_core.compute_exit_actions_v2(transition_record := transition_record, p_state_node_set := p_state_node_set, p_fsm_name := fsm_name_param, p_fsm_version := fsm_version_param) INTO result;


    RETURN result;
END;
$function$
;


