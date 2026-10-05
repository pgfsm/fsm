-- ── Hand-written (#469): not captured by `supabase db diff` ─────────────────
-- Copied verbatim from supabase/schemas/40_access_control/20261005120100_fsm_core_access_control.sql.
-- Roles must exist before the diffed table grants at the end of this file.

-- ── Roles (cluster-wide; idempotent) ────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fsm_operator') THEN
    CREATE ROLE fsm_operator NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fsm_admin') THEN
    CREATE ROLE fsm_admin NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fsm_worker') THEN
    CREATE ROLE fsm_worker NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fsm_authenticator') THEN
    CREATE ROLE fsm_authenticator LOGIN NOINHERIT;
  END IF;
END;
$$;

GRANT fsm_operator TO fsm_admin;
GRANT fsm_operator TO fsm_authenticator;
-- The owner (on Supabase `postgres`, not a superuser) can't SET ROLE to roles
-- it isn't a member of. Membership lets it test the roles (pgTAP does) and
-- grant them onward; it changes nothing else, since the owner already holds
-- every privilege these roles have. Granted by name: on Supabase (PG 15.8),
-- `GRANT … TO CURRENT_USER` segfaults the backend.
DO $$
BEGIN
  EXECUTE format('GRANT fsm_operator, fsm_admin, fsm_worker, fsm_authenticator TO %I', current_user);
END;
$$;


  create table "fsm_core"."api_keys" (
    "id" uuid not null default gen_random_uuid(),
    "name" text not null,
    "role" text not null,
    "prefix" text not null,
    "key_hash" bytea not null,
    "created_at" timestamp with time zone not null default now(),
    "last_used_at" timestamp with time zone,
    "revoked_at" timestamp with time zone
      );


CREATE UNIQUE INDEX api_keys_key_hash_key ON fsm_core.api_keys USING btree (key_hash);

CREATE UNIQUE INDEX api_keys_name_key ON fsm_core.api_keys USING btree (name);

CREATE UNIQUE INDEX api_keys_pkey ON fsm_core.api_keys USING btree (id);

alter table "fsm_core"."api_keys" add constraint "api_keys_pkey" PRIMARY KEY using index "api_keys_pkey";

alter table "fsm_core"."api_keys" add constraint "api_keys_key_hash_key" UNIQUE using index "api_keys_key_hash_key";

alter table "fsm_core"."api_keys" add constraint "api_keys_name_key" UNIQUE using index "api_keys_name_key";

alter table "fsm_core"."api_keys" add constraint "api_keys_role_check" CHECK ((role = ANY (ARRAY['fsm_admin'::text, 'fsm_operator'::text]))) not valid;

alter table "fsm_core"."api_keys" validate constraint "api_keys_role_check";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.create_api_key(input_name text, input_role text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pg_temp'
AS $function$
DECLARE
  v_key_prefix text;
  v_key        text;
  v_id         uuid;
BEGIN
  IF input_name IS NULL OR btrim(input_name) = '' THEN
    RAISE EXCEPTION 'create_api_key: name is required' USING ERRCODE = '22023';
  END IF;

  v_key_prefix := CASE input_role
    WHEN 'fsm_admin'    THEN 'pgfsm_admin_'
    WHEN 'fsm_operator' THEN 'pgfsm_op_'
  END;
  IF v_key_prefix IS NULL THEN
    RAISE EXCEPTION 'create_api_key: role must be fsm_admin or fsm_operator, got %', input_role
      USING ERRCODE = '22023';
  END IF;

  v_key := v_key_prefix || encode(
    uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()), 'hex');

  INSERT INTO fsm_core.api_keys (name, role, prefix, key_hash)
  VALUES (input_name, input_role, left(v_key, length(v_key_prefix) + 8),
          sha256(convert_to(v_key, 'UTF8')))
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'id', v_id,
    'name', input_name,
    'role', input_role,
    'prefix', left(v_key, length(v_key_prefix) + 8),
    'key', v_key
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.list_api_keys()
 RETURNS TABLE(id uuid, name text, role text, prefix text, created_at timestamp with time zone, last_used_at timestamp with time zone, revoked_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pg_temp'
AS $function$
  SELECT k.id, k.name, k.role, k.prefix, k.created_at, k.last_used_at, k.revoked_at
  FROM fsm_core.api_keys k
  ORDER BY k.created_at DESC;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.revoke_api_key(input_id_or_name text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pg_temp'
AS $function$
DECLARE
  v_count int;
BEGIN
  UPDATE fsm_core.api_keys
  SET revoked_at = now()
  WHERE revoked_at IS NULL
    AND (id::text = input_id_or_name OR name = input_id_or_name);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.verify_api_key(input_key_hash bytea)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pg_temp'
AS $function$
DECLARE
  v_id   uuid;
  v_role text;
  v_last timestamptz;
BEGIN
  SELECT k.id, k.role, k.last_used_at INTO v_id, v_role, v_last
  FROM fsm_core.api_keys k
  WHERE k.key_hash = input_key_hash AND k.revoked_at IS NULL;

  IF v_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_last IS NULL OR v_last < now() - interval '1 minute' THEN
    UPDATE fsm_core.api_keys SET last_used_at = now() WHERE id = v_id;
  END IF;

  RETURN v_role;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.archive_event_from_fsm_async_operation_type_worker_v2(input_async_operation_queue_name text, input_async_operation_queue_type text, input_async_operation_queue_version text, input_async_operation_queue_msg_id bigint, input_event_name text, input_event_action_type text, input_event_data jsonb, input_event_delay integer, input_send_to_parent_queue_id uuid, input_send_to_parent_queue_id_event_name text, input_execution_started_at timestamp with time zone, input_execution_duration integer, input_execution_finished_at timestamp with time zone, input_event_status text, input_event_output jsonb, input_error_message text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    async_operation_archive_result boolean;
    send_to_parent_result jsonb;
    output_async_operation_queue_event_log_id uuid;
BEGIN
    -- 1. Remove event from async-operation queue
    async_operation_archive_result := pgmq.archive(
        queue_name := input_async_operation_queue_name,
        msg_id := input_async_operation_queue_msg_id
    );

    -- 2. Send async-operation result back to parent FSM queue -- only when
    -- there is a real parent to notify.
    IF input_send_to_parent_queue_id IS NOT NULL
        AND input_send_to_parent_queue_id <> fsm_core.pg_system_queue_uuid()
        AND input_send_to_parent_queue_id <> fsm_core.api_system_queue_uuid()
    THEN
        send_to_parent_result := fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
            input_fsm_instance_id := input_send_to_parent_queue_id,
            input_fsm_instance_id_fsm_type := NULL,
            input_fsm_instance_id_fsm_version := NULL,
            input_send_to_parent_queue_id := fsm_core.pg_system_queue_uuid(),
            input_send_to_parent_queue_type := fsm_core.pg_system_queue_type(),
            input_send_to_parent_queue_id_event_name := fsm_core.pg_system_event_name(),
            input_event_name := input_event_name,
            input_event_action_type := 'async_operation_completed',
            input_event_data := input_event_output,
            input_event_delay := 0,
            input_event_status := input_event_status,
            input_event_output := input_event_output,
            input_error_message := input_error_message,
            input_execution_started_at := input_execution_started_at,
            input_execution_duration := input_execution_duration,
            input_execution_finished_at := input_execution_finished_at
        );
    ELSE
        send_to_parent_result := jsonb_build_object('skipped', true, 'reason', 'no real parent to notify');
    END IF;

    -- 3. Log archive event in async-operation queue event logs
    INSERT INTO fsm_core.fsm_async_operation_queue_event_logs (
        async_operation_queue_name,
        async_operation_queue_type,
        async_operation_queue_version,
        async_operation_queue_msg_id,
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
        input_async_operation_queue_name,
        input_async_operation_queue_type,
        input_async_operation_queue_version,
        input_async_operation_queue_msg_id,
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
    ) RETURNING async_operation_queue_event_log_id INTO output_async_operation_queue_event_log_id;

    RETURN jsonb_build_object(
        'async_operation_queue_archive_result', async_operation_archive_result,
        'async_operation_queue_name', input_async_operation_queue_name,
        'async_operation_queue_msg_id', input_async_operation_queue_msg_id,
        'send_to_parent_result', send_to_parent_result,
        'async_operation_queue_event_log_id', output_async_operation_queue_event_log_id
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.archive_event_from_fsm_type_worker_v2(remove_from_current_fsm_instance_queue_id text, remove_current_queue_msg_id bigint, to_be_removed_schedule_queue_msg_ids jsonb, to_be_removed_async_operation_queue_msg_ids jsonb, to_be_added_schedule_queue_data jsonb, to_be_added_async_operation_queue_data jsonb, input_total_schedule_queue_data jsonb, input_total_async_operation_queue_data jsonb, fsm_instance_data_save_fsm_status jsonb, fsm_instance_data_save_fsm_state jsonb, fsm_instance_data_save_fsm_context jsonb, fsm_instance_data_save_fsm_xstate_state jsonb, send_to_parent_queue_id uuid, send_to_parent_queue_type text, send_to_parent_queue_id_event_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    i int;

    schedule_queue_entry jsonb;
    remove_schedule boolean;
    schedule_queue_message jsonb;
    confirmed_removed_schedule_queue_data jsonb[] := '{}';
    confirmed_match_for_schedule boolean;
    not_confirmed_removed_schedule_queue_data jsonb[] := '{}';

    async_operation_queue_entry jsonb;
    remove_async_operation boolean;
    async_operation_queue_message jsonb;
    confirmed_removed_async_operation_queue_data jsonb[] := '{}';
    confirmed_match_for_async_operation boolean;
    not_confirmed_removed_async_operation_queue_data jsonb[] := '{}';

    to_be_added_schedule_queue_data_entry jsonb;
    to_be_added_schedule_queue_data_entry_delay int;
    output_schedule_result jsonb;

    to_be_added_async_operation_queue_data_entry jsonb;
    output_async_operation_result jsonb;

    new_total_schedule_queue_data jsonb := '[]'::jsonb;
    new_total_async_operation_queue_data jsonb := '[]'::jsonb;

    confirmed_removed_schedule_queue_data_success jsonb[] := '{}';
    confirmed_removed_schedule_queue_data_failed jsonb[] := '{}';

    confirmed_removed_async_operation_queue_data_success jsonb[] := '{}';
    confirmed_removed_async_operation_queue_data_failed jsonb[] := '{}';

    added_schedule_queue_data jsonb[] := '{}';
    added_async_operation_queue_data jsonb[] := '{}';
    parent_notify_result jsonb;
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


    -- 2. Cancel events for async-operation type workers and remove from input_total_async_operation_queue_data
    -- A = 'input_total_async_operation_queue_data'
    -- B = 'to_be_removed_async_operation_queue_msg_ids'
    -- C = 'confirmed_removed_async_operation_queue_data' (used for canceling events) ( C = A intersect B )
    -- D = 'not_confirmed_removed_async_operation_queue_data' (used for returning to caller) ( D = B - C )
    IF input_total_async_operation_queue_data IS NOT NULL THEN
        new_total_async_operation_queue_data := '[]'::jsonb;
        FOR async_operation_queue_entry IN
            SELECT value FROM jsonb_array_elements(input_total_async_operation_queue_data) value
        LOOP
            remove_async_operation := false;
            IF to_be_removed_async_operation_queue_msg_ids IS NOT NULL THEN
                FOR i IN 0 .. jsonb_array_length(to_be_removed_async_operation_queue_msg_ids)-1 LOOP
                    async_operation_queue_message := to_be_removed_async_operation_queue_msg_ids->i;

                    IF (
                        (async_operation_queue_entry->>'sendToParentQueueIdEventName')::text = (async_operation_queue_message->>'id')::text
                        AND (async_operation_queue_entry->>'queueFnName')::text = (async_operation_queue_message->>'src')::text
                    ) THEN
                        remove_async_operation := true;

                        EXIT;
                    END IF;
                END LOOP;
            END IF;

            IF remove_async_operation THEN
                confirmed_removed_async_operation_queue_data := array_append(confirmed_removed_async_operation_queue_data, async_operation_queue_entry);
            ELSE
                new_total_async_operation_queue_data := array_append(new_total_async_operation_queue_data, async_operation_queue_entry);
            END IF;
        END LOOP;


    END IF;

    -- 2b. Derive not_confirmed_removed_async_operation_queue_data
    -- D = B - C => not_confirmed_removed_async_operation_queue_data = to_be_removed_async_operation_queue_msg_ids - confirmed_removed_async_operation_queue_data
    IF to_be_removed_async_operation_queue_msg_ids IS NOT NULL THEN
        FOR i IN 0 .. jsonb_array_length(to_be_removed_async_operation_queue_msg_ids)-1 LOOP
            async_operation_queue_message := to_be_removed_async_operation_queue_msg_ids->i;
            confirmed_match_for_async_operation := false;
            FOREACH async_operation_queue_entry IN ARRAY confirmed_removed_async_operation_queue_data LOOP
                IF (
                    (async_operation_queue_entry->>'sendToParentQueueIdEventName')::text = (async_operation_queue_message->>'id')::text
                    AND (async_operation_queue_entry->>'queueFnName')::text = (async_operation_queue_message->>'src')::text
                ) THEN
                    confirmed_match_for_async_operation := true;
                    EXIT;
                END IF;
            END LOOP;

            IF NOT confirmed_match_for_async_operation THEN
                not_confirmed_removed_async_operation_queue_data := array_append(not_confirmed_removed_async_operation_queue_data, async_operation_queue_message);
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

    -- 4. Cancel events for async-operation type workers.
    IF confirmed_removed_async_operation_queue_data IS NOT NULL THEN
        FOR i IN 1 .. COALESCE(array_length(confirmed_removed_async_operation_queue_data, 1), 0) LOOP
            async_operation_queue_entry := confirmed_removed_async_operation_queue_data[i];
            -- pq_name := async_operation_queue_entry->>'async_operation_queue_name';
            -- pq_msg_id := NULL;
            -- BEGIN
                -- pq_msg_id := (async_operation_queue_entry->>'queue_msg_id')::bigint;
            -- EXCEPTION WHEN invalid_text_representation THEN
            --     pq_msg_id := NULL;
            -- END;
            -- IF pq_name IS NOT NULL AND pq_name <> '' AND pq_msg_id IS NOT NULL THEN
                PERFORM fsm_core.cancel_event_for_fsm_async_operation_type_worker_v2(
                    async_operation_type_worker_name := (async_operation_queue_entry->>'queueId')::text,
                    queue_msg_id := (async_operation_queue_entry->>'queueMsgId')::bigint
                );
                confirmed_removed_async_operation_queue_data_success := array_append(confirmed_removed_async_operation_queue_data_success, async_operation_queue_entry);
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
                input_send_to_parent_queue_type := 'FSM OR childFSM OR sharedFSM', -- # TODO : pending
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

    -- 6. Send new async-operation events and collect results
    IF to_be_added_async_operation_queue_data IS NOT NULL THEN
        FOR i IN 0 .. jsonb_array_length(to_be_added_async_operation_queue_data)-1 LOOP
            to_be_added_async_operation_queue_data_entry := to_be_added_async_operation_queue_data->i;
            -- IF (to_be_added_async_operation_queue_data_entry->>'src') IS NOT NULL AND (to_be_added_async_operation_queue_data_entry->>'src') <> '' THEN
                -- output_async_operation_result := fsm_core.send_event_to_fsm_async_operation_queue_from_fsm_instance_id_v2(
                --     to_be_added_async_operation_queue_data_entry->>'id', -- type can be also used here
                --     to_be_added_async_operation_queue_data_entry->'input',
                --     to_be_added_async_operation_queue_data_entry->>'src',
                --     remove_from_current_fsm_instance_queue_id::uuid
                --     -- CASE WHEN remove_from_current_fsm_instance_queue_id IS NOT NULL AND remove_from_current_fsm_instance_queue_id <> '' THEN remove_from_current_fsm_instance_queue_id::uuid ELSE NULL::uuid END
                -- );

                output_async_operation_result := fsm_core.send_event_to_queue_from_fsm_instance_id_v2(
                    event_name := to_be_added_async_operation_queue_data_entry->>'id',
                    event_input := to_be_added_async_operation_queue_data_entry->'input',
                    id := to_be_added_async_operation_queue_data_entry->>'id',
                    action_type := to_be_added_async_operation_queue_data_entry->>'action_type',
                    src := to_be_added_async_operation_queue_data_entry->>'src',
                    asyncOperationName := to_be_added_async_operation_queue_data_entry->>'src',
                    asyncOperationType := to_be_added_async_operation_queue_data_entry->>'asyncOperationType',
                    asyncOperationVersion := to_be_added_async_operation_queue_data_entry->>'asyncOperationVersion',
                    parentFsmName := to_be_added_async_operation_queue_data_entry->>'parentFsmName',
                    parentFsmVersion := to_be_added_async_operation_queue_data_entry->>'parentFsmVersion',
                    asyncOperationLanguage := to_be_added_async_operation_queue_data_entry->>'asyncOperationLanguage',
                    from_source_fsm_instance_id := remove_from_current_fsm_instance_queue_id::uuid
                    -- CASE WHEN remove_from_current_fsm_instance_queue_id IS NOT NULL AND remove_from_current_fsm_instance_queue_id <> '' THEN remove_from_current_fsm_instance_queue_id::uuid ELSE NULL::uuid END
                );
            -- ELSE
            --     output_async_operation_result := NULL;
            -- END IF;
            added_async_operation_queue_data := array_append(added_async_operation_queue_data, output_async_operation_result->'queue_data');
            new_total_async_operation_queue_data := new_total_async_operation_queue_data ||  (output_async_operation_result->'queue_data');
        END LOOP;
    END IF;

    -- 7. Update fsm_instance (pseudo-code, adjust as needed)
    UPDATE fsm_core.fsm_instance
    SET
        total_schedule_queue_data = new_total_schedule_queue_data,
        total_async_operation_queue_data = new_total_async_operation_queue_data,
        fsm_instance_status = fsm_instance_data_save_fsm_status,
        fsm_instance_state = fsm_instance_data_save_fsm_state,
        fsm_instance_context = fsm_instance_data_save_fsm_context,
        fsm_instance_xstate_state = fsm_instance_data_save_fsm_xstate_state
    WHERE id = remove_from_current_fsm_instance_queue_id::uuid;

    -- 8. All above macro steps are completed so remove current queue_msg_id from current_workflow_queue_id
    PERFORM pgmq.archive(queue_name := remove_from_current_fsm_instance_queue_id, msg_id := remove_current_queue_msg_id::bigint);

    -- 9. If FSM reached a terminal state and has a real parent queue, notify the parent
    IF (fsm_instance_data_save_fsm_status #>> '{}') IN ('done', 'stopped', 'completed', 'final')
        AND send_to_parent_queue_id IS NOT NULL
        AND send_to_parent_queue_id != fsm_core.pg_system_queue_uuid()
        AND send_to_parent_queue_id != fsm_core.api_system_queue_uuid()
    THEN
        parent_notify_result := fsm_core.send_event_to_fsm_queue_with_event_logs_v2(
            input_fsm_instance_id              := send_to_parent_queue_id,
            input_fsm_instance_id_fsm_type     := send_to_parent_queue_type,
            input_fsm_instance_id_fsm_version  := NULL,
            input_send_to_parent_queue_id      := fsm_core.pg_system_queue_uuid(),
            input_send_to_parent_queue_type    := fsm_core.pg_system_queue_type(),
            input_send_to_parent_queue_id_event_name := fsm_core.pg_system_event_name(),
            input_event_name                   := send_to_parent_queue_id_event_name,
            input_event_action_type            := 'childFsm_completed',
            input_event_data                   := fsm_instance_data_save_fsm_context,
            input_event_delay                  := 0,
            input_event_status                 := 'ACTIVE',
            input_event_output                 := '{}'::jsonb,
            input_error_message                := NULL
        );
    END IF;

    RETURN jsonb_build_object(
         'confirmed_removed_schedule_queue_data_success', confirmed_removed_schedule_queue_data_success,
         'confirmed_removed_async_operation_queue_data_success', confirmed_removed_async_operation_queue_data_success,

         'confirmed_removed_schedule_queue_data_failed', confirmed_removed_schedule_queue_data_failed,
         'confirmed_removed_async_operation_queue_data_failed', confirmed_removed_async_operation_queue_data_failed,

         'not_confirmed_removed_schedule_queue_data', not_confirmed_removed_schedule_queue_data,
         'not_confirmed_removed_async_operation_queue_data', not_confirmed_removed_async_operation_queue_data,

         'added_schedule_queue_data', added_schedule_queue_data,
         'added_async_operation_queue_data', added_async_operation_queue_data,

         'new_total_schedule_queue_data', new_total_schedule_queue_data,
         'new_total_async_operation_queue_data', new_total_async_operation_queue_data,

         'old_total_schedule_queue_data', input_total_schedule_queue_data,
         'old_total_async_operation_queue_data', input_total_async_operation_queue_data,
         'parent_notify_result', parent_notify_result
      );

END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.async_operation_schedule_next_pending(input_stale_threshold_seconds integer DEFAULT 30)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_entry_id                  uuid;
  v_instance_id               uuid;
  v_async_operation_name      text;
  v_async_operation_version   text;
  v_parent_fsm_name           text;
  v_parent_fsm_version        text;
  v_chosen_workerlet_id       uuid;
BEGIN
  -- Step 1: claim the oldest pending entry (SKIP LOCKED = safe for parallel schedulers).
  SELECT
    async_operation_instance_and_async_operation_workerlet_id,
    async_operation_instance_id,
    async_operation_name,
    async_operation_version,
    parent_fsm_name,
    parent_fsm_version
  INTO
    v_entry_id,
    v_instance_id,
    v_async_operation_name,
    v_async_operation_version,
    v_parent_fsm_name,
    v_parent_fsm_version
  FROM fsm_core.async_operation_instance_and_async_operation_workerlet
  WHERE status = 'pending'
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_entry_id IS NULL THEN
    RETURN false;
  END IF;

  -- Step 2: pick the best available workerlet.
  --   Filter: heartbeat within threshold (node is alive)
  --           AND supported_async_operations contains this operation
  --           AND active_pid_number < max_pid_number (has a free slot)
  --   Score:  most available slots first (max_pid_number - active_pid_number DESC)
  SELECT async_operation_workerlet_id
  INTO v_chosen_workerlet_id
  FROM fsm_core.async_operation_workerlet
  WHERE
    last_heartbeat > NOW() - (input_stale_threshold_seconds || ' seconds')::interval
    AND active_pid_number < max_pid_number
    AND supported_async_operations @> jsonb_build_array(
          jsonb_build_object(
            'async_operation_name',    v_async_operation_name,
            'async_operation_version', v_async_operation_version,
            'parent_fsm_name',         v_parent_fsm_name,
            'parent_fsm_version',      v_parent_fsm_version
          )
        )
  ORDER BY (max_pid_number - active_pid_number) DESC
  LIMIT 1;

  IF v_chosen_workerlet_id IS NULL THEN
    -- No capable workerlet right now — leave status=pending, retry on next cycle.
    RETURN false;
  END IF;

  -- Step 3: assign the entry to the chosen workerlet.
  UPDATE fsm_core.async_operation_instance_and_async_operation_workerlet
  SET
    status                       = 'scheduled',
    async_operation_workerlet_id = v_chosen_workerlet_id,
    scheduled_at                 = NOW()
  WHERE async_operation_instance_and_async_operation_workerlet_id = v_entry_id;

  -- Step 4: wake the workerlet via pg_notify.
  -- Prefix must keep prefix + uuid within PostgreSQL's 63-byte channel-name
  -- limit (pg_notify errors above it). Must match
  -- asyncOperationWorkerletNotifyChannel in fsm-core-db-ts.
  PERFORM pg_notify(
    'async_op_workerlet_work_' || v_chosen_workerlet_id::text,
    v_instance_id::text
  );

  RETURN true;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.check_registry_for_async_actors(input_async_actors jsonb, input_fsm_name text, input_fsm_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_actor          record;
  v_missing_actors jsonb := '[]'::jsonb;
  v_found          boolean;
BEGIN
  FOR v_actor IN
    SELECT
      elem->>'src'        AS src,
      elem->>'fsmVersion' AS fsm_version
    FROM jsonb_array_elements(input_async_actors) AS elem
  LOOP
    SELECT EXISTS (
      SELECT 1
      FROM fsm_core.async_operation_meta
      WHERE parent_fsm_name       = input_fsm_name
        AND parent_fsm_version    = input_fsm_version
        AND async_operation_name  = v_actor.src
        AND async_operation_version = v_actor.fsm_version
    ) INTO v_found;

    IF NOT v_found THEN
      v_missing_actors := v_missing_actors || jsonb_build_array(
        jsonb_build_object(
          'src',        v_actor.src,
          'fsmVersion', v_actor.fsm_version
        )
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'all_registered', jsonb_array_length(v_missing_actors) = 0,
    'missing_actors', v_missing_actors,
    'fsm_name',       input_fsm_name,
    'fsm_version',    input_fsm_version
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.claim_pending_async_operation_events_for_workers_v2(input_workers jsonb)
 RETURNS SETOF jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    worker jsonb;
    computed_queue_name text;
    queue_exists boolean;
    msg pgmq.message_record;
BEGIN
    FOR worker IN SELECT * FROM jsonb_array_elements(input_workers)
    LOOP
        computed_queue_name := fsm_core.compute_async_operation_queue_name_v2(
            worker->>'parent_fsm_name', worker->>'parent_fsm_version',
            worker->>'async_operation_type', worker->>'async_operation_name',
            worker->>'async_operation_version', worker->>'async_operation_language'
        );

        SELECT EXISTS (
            SELECT 1 FROM pgmq.meta WHERE queue_name = computed_queue_name
        ) INTO queue_exists;

        IF NOT queue_exists THEN
            CONTINUE;
        END IF;

        FOR msg IN
            SELECT * FROM pgmq.read(computed_queue_name, 30, 1)
        LOOP
            RETURN NEXT jsonb_build_object(
                'parentFsmName', worker->>'parent_fsm_name',
                'parentFsmVersion', worker->>'parent_fsm_version',
                'asyncOperationType', worker->>'async_operation_type',
                'asyncOperationName', worker->>'async_operation_name',
                'asyncOperationVersion', worker->>'async_operation_version',
                'asyncOperationLanguage', worker->>'async_operation_language',
                'input', msg.message->'eventData'->'eventPayload',
                'instanceId', msg.message->>'sendToParentQueueId',
                'correlationId', msg.msg_id::text,
                'asyncOperationQueueName', computed_queue_name,
                'asyncOperationQueueType', worker->>'async_operation_type',
                'asyncOperationQueueVersion', worker->>'async_operation_version',
                'msgId', msg.msg_id,
                'eventName', msg.message->>'sendToParentQueueIdEventName',
                'eventActionType', msg.message->'eventData'->>'actionType',
                'eventDelay', COALESCE((msg.message->>'queueMsgDelay')::integer, 0),
                'sendToParentQueueId', msg.message->>'sendToParentQueueId',
                'sendToParentQueueIdEventName', msg.message->>'sendToParentQueueIdEventName'
            );
        END LOOP;
    END LOOP;

    RETURN;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.claim_pending_async_operation_events_with_capacity_v2(input_workers jsonb)
 RETURNS SETOF jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    worker jsonb;
    computed_queue_name text;
    queue_exists boolean;
    claim_qty integer;
    claim_vt integer;
    msg pgmq.message_record;
BEGIN
    FOR worker IN SELECT * FROM jsonb_array_elements(input_workers)
    LOOP
        claim_qty := COALESCE((worker->>'qty')::integer, 0);
        IF claim_qty <= 0 THEN
            CONTINUE;
        END IF;
        claim_vt := GREATEST(COALESCE((worker->>'vt_seconds')::integer, 30), 1);

        computed_queue_name := fsm_core.compute_async_operation_queue_name_v2(
            worker->>'parent_fsm_name', worker->>'parent_fsm_version',
            worker->>'async_operation_type', worker->>'async_operation_name',
            worker->>'async_operation_version', worker->>'async_operation_language'
        );
        SELECT EXISTS (
            SELECT 1 FROM pgmq.meta WHERE queue_name = computed_queue_name
        ) INTO queue_exists;
        IF NOT queue_exists THEN
            CONTINUE;
        END IF;

        FOR msg IN
            SELECT * FROM pgmq.read(computed_queue_name, claim_vt, claim_qty)
        LOOP
            RETURN NEXT jsonb_build_object(
                'parentFsmName', worker->>'parent_fsm_name',
                'parentFsmVersion', worker->>'parent_fsm_version',
                'asyncOperationType', worker->>'async_operation_type',
                'asyncOperationName', worker->>'async_operation_name',
                'asyncOperationVersion', worker->>'async_operation_version',
                'asyncOperationLanguage', worker->>'async_operation_language',
                'input', msg.message->'eventData'->'eventPayload',
                'instanceId', msg.message->>'sendToParentQueueId',
                'correlationId', msg.msg_id::text,
                'asyncOperationQueueName', computed_queue_name,
                'asyncOperationQueueType', worker->>'async_operation_type',
                'asyncOperationQueueVersion', worker->>'async_operation_version',
                'msgId', msg.msg_id,
                'readCount', msg.read_ct,
                'eventName', msg.message->>'sendToParentQueueIdEventName',
                'eventActionType', msg.message->'eventData'->>'actionType',
                'eventDelay', COALESCE((msg.message->>'queueMsgDelay')::integer, 0),
                'sendToParentQueueId', msg.message->>'sendToParentQueueId',
                'sendToParentQueueIdEventName', msg.message->>'sendToParentQueueIdEventName'
            );
        END LOOP;
    END LOOP;
    RETURN;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.claim_scheduled_for_async_operation_workerlet(input_workerlet_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  WITH claimed AS (
    DELETE FROM fsm_core.async_operation_instance_and_async_operation_workerlet
    WHERE async_operation_instance_and_async_operation_workerlet_id = (
      SELECT async_operation_instance_and_async_operation_workerlet_id
      FROM fsm_core.async_operation_instance_and_async_operation_workerlet
      WHERE status = 'scheduled'
        AND async_operation_workerlet_id = input_workerlet_id
      ORDER BY scheduled_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  )
  SELECT row_to_json(claimed.*)::jsonb INTO v_result FROM claimed;
  RETURN v_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.claim_scheduled_for_fsmlet(input_fsmlet_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_entry_id      uuid;
  v_instance_id   uuid;
  v_fsm_name      text;
  v_fsm_version   text;
  v_dispatch_type text;
BEGIN
  -- Claim one scheduled entry for this fsmlet (SKIP LOCKED = safe for parallel coroutines).
  SELECT
    fsm_instance_and_fsm_workerlet_id,
    fsm_instance_id,
    fsm_name,
    fsm_version,
    dispatch_type
  INTO v_entry_id, v_instance_id, v_fsm_name, v_fsm_version, v_dispatch_type
  FROM fsm_core.fsm_instance_and_fsm_workerlet
  WHERE status = 'scheduled'
    AND fsm_workerlet_id = input_fsmlet_id
  ORDER BY scheduled_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_entry_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Delete the row — in-memory activeWorkers map on the fsmlet tracks what's running.
  DELETE FROM fsm_core.fsm_instance_and_fsm_workerlet
  WHERE fsm_instance_and_fsm_workerlet_id = v_entry_id;

  RETURN jsonb_build_object(
    'fsm_instance_and_fsm_workerlet_id', v_entry_id,
    'fsm_instance_id',                   v_instance_id,
    'fsm_name',                          v_fsm_name,
    'fsm_version',                       v_fsm_version,
    'dispatch_type',                     v_dispatch_type
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.compute_async_operation_queue_name_v2(input_parent_fsm_name text, input_parent_fsm_version text, input_async_operation_type text, input_async_operation_name text, input_async_operation_version text, input_async_operation_language text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
    IF input_async_operation_type = 'internalAsyncOperation' THEN
        RETURN input_parent_fsm_name || '_' || input_parent_fsm_version
            || '_' || LEFT(input_async_operation_type, 1) || '_' || input_async_operation_name || '_'
            || LEFT(input_async_operation_language, 1);
    ELSIF input_async_operation_type = 'sharedAsyncOperation' THEN
        RETURN LEFT(input_parent_fsm_name, 1) || '_' || input_parent_fsm_version
            || '_' || LEFT(input_async_operation_type, 1) || '_' || input_async_operation_name || '_'
            || input_async_operation_language;
    ELSE
        RAISE EXCEPTION 'compute_async_operation_queue_name_v2: unsupported input_async_operation_type: %', input_async_operation_type;
    END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.create_fsm_instance_from_name_v2(input_fsm_name text, input_fsm_version text, input_fsm_context jsonb, create_pgmq_queue boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    output_queue_created boolean := false;
    output_message text := NULL;
    output_extra_message text := NULL;
    fsm_instance_id uuid;
    send_event_result jsonb := NULL;
    derived_fsm_type text;
    fsm_json_exists boolean;
    fsm_instance_row      fsm_core.fsm_instance;
BEGIN
    -- 1. Check if fsm_name and fsm_version exist in fsm_core.fsm_json
    SELECT EXISTS (
        SELECT 1
        FROM fsm_core.fsm_json fj
        WHERE fj.fsm_name = input_fsm_name AND fj.fsm_version = input_fsm_version
    ) INTO fsm_json_exists;

    IF NOT fsm_json_exists THEN
        RAISE EXCEPTION 'FSM with name % and version % not found in fsm_core.fsm_json', input_fsm_name, input_fsm_version;
    END IF;

    -- 1.1. Derive fsm_type from fsm_core.fsm_dependencies: a row where this FSM
    -- is a child means it's a childfsm, otherwise it's a top-level fsm.
    IF EXISTS (
        SELECT 1
        FROM fsm_core.fsm_dependencies fd
        WHERE fd.child_fsm_name = input_fsm_name AND fd.child_fsm_version = input_fsm_version
    ) THEN
        derived_fsm_type := 'childfsm';
    ELSE
        derived_fsm_type := 'fsm';
    END IF;

    -- 2. Create new fsm_instance
    INSERT INTO fsm_core.fsm_instance (fsm_name, fsm_version, fsm_type, fsm_instance_context)
    VALUES (input_fsm_name, input_fsm_version, derived_fsm_type, input_fsm_context)
    RETURNING * INTO fsm_instance_row;

    fsm_instance_id := fsm_instance_row.id;

    -- 3. Insert all transitions into fsm_core.fsm_instance_transitions_auth
    INSERT INTO fsm_core.fsm_instance_transitions_auth (
        fsm_name, fsm_version, fsm_type, fsm_instance_id, fsm_instance_event_type, users, groups, module_tag, meta_info
    )
    SELECT
        t.fsm_name,
        t.fsm_version,
        derived_fsm_type,
        fsm_instance_id,
        t.event_type,
        ARRAY[]::jsonb[], -- users (default empty array)
        ARRAY[]::jsonb[], -- groups (default empty array)
        NULL::jsonb,      -- module_tag (default null)
        NULL::jsonb       -- meta_info (default null)
    FROM fsm_core.fsm_transitions t
    WHERE t.fsm_name = input_fsm_name AND t.fsm_version = input_fsm_version;

    -- 4. Enqueue to fsm_instance_and_fsm_workerlet and notify the fsmscheduler.
    PERFORM fsm_core.enqueue_fsm_dispatch_v2(
        fsm_instance_id,
        input_fsm_name,
        input_fsm_version,
        'start'
    );

    -- 5. Optionally create pgmq queue and send initial event
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
                    input_send_to_parent_queue_id := fsm_core.pg_system_queue_uuid(),
                    input_send_to_parent_queue_type := fsm_core.pg_system_queue_type(),
                    input_send_to_parent_queue_id_event_name := fsm_core.pg_system_event_name(),
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

CREATE OR REPLACE FUNCTION fsm_core.enqueue_fsm_dispatch_v2(input_instance_id uuid, input_fsm_name text, input_fsm_version text, input_dispatch_type text DEFAULT 'start'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO fsm_core.fsm_instance_and_fsm_workerlet (fsm_instance_id, fsm_name, fsm_version, dispatch_type)
  VALUES (input_instance_id, input_fsm_name, input_fsm_version, input_dispatch_type);

  PERFORM pg_notify('fsm_scheduler_work', input_instance_id::text);
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.ensure_async_operation_queue_for_worker_v2(input_parent_fsm_name text, input_parent_fsm_version text, input_async_operation_type text, input_async_operation_name text, input_async_operation_version text, input_async_operation_language text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    computed_queue_name text;
    already_existed boolean;
BEGIN
    computed_queue_name := fsm_core.compute_async_operation_queue_name_v2(
        input_parent_fsm_name, input_parent_fsm_version, input_async_operation_type,
        input_async_operation_name, input_async_operation_version, input_async_operation_language
    );

    SELECT EXISTS (
        SELECT 1 FROM pgmq.meta WHERE queue_name = computed_queue_name
    ) INTO already_existed;

    IF NOT already_existed THEN
        PERFORM pgmq.create(computed_queue_name);
    END IF;

    RETURN jsonb_build_object(
        'queue_name', computed_queue_name,
        'already_existed', already_existed
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.get_fsm_data_resolve_state_value_v2(input_fsm_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
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

CREATE OR REPLACE FUNCTION fsm_core.load_async_operation_meta_v2(input_async_operation_name text, input_async_operation_version text, input_async_operation_type text, input_async_operation_language text, input_parent_fsm_name text, input_parent_fsm_version text, input_updated_by_pid text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  INSERT INTO fsm_core.async_operation_meta (
    async_operation_name,
    async_operation_version,
    async_operation_type,
    async_operation_language,
    parent_fsm_name,
    parent_fsm_version,
    updated_by_pid
  ) VALUES (
    input_async_operation_name,
    input_async_operation_version,
    input_async_operation_type,
    input_async_operation_language,
    input_parent_fsm_name,
    input_parent_fsm_version,
    input_updated_by_pid
  )
  ON CONFLICT ON CONSTRAINT async_operation_meta_unique
  DO UPDATE SET
    updated_at             = now(),
    updated_by_pid         = input_updated_by_pid
  RETURNING jsonb_build_object(
    'async_operation_meta_id',async_operation_meta_id,
    'async_operation_name',   async_operation_name,
    'async_operation_version', async_operation_version,
    'async_operation_type',   async_operation_type,
    'async_operation_language', async_operation_language,
    'parent_fsm_name',        parent_fsm_name,
    'parent_fsm_version',     parent_fsm_version,
    'updated_at',             updated_at,
    'updated_by_pid',         updated_by_pid
  ) INTO v_result;

  RETURN v_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.load_fsm_from_json_v2(json_input jsonb, root_node_text text, input_fsm_name text, input_fsm_version text, input_dependent_children jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
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

CREATE OR REPLACE FUNCTION fsm_core.load_fsm_state_from_json_v2(json_input jsonb, root_node_text text, input_fsm_name text, input_fsm_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
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

CREATE OR REPLACE FUNCTION fsm_core.load_fsm_transition_from_json_v2(json_input jsonb, root_node_text text, fsm_name text, fsm_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
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

CREATE OR REPLACE FUNCTION fsm_core.lock_fsm_instance(input_fsm_instance_id uuid, input_locked_by text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    updated_count INTEGER;
BEGIN
    UPDATE fsm_core.fsm_instance
    SET
        worker_locked          = TRUE,
        worker_locked_by       = input_locked_by,
        worker_locked_at       = now(),
        worker_lock_expires_at = NULL
    WHERE id = input_fsm_instance_id
      AND (worker_locked = FALSE OR worker_locked IS NULL);

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count > 0;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.microstep_v2(transition_record fsm_core.fsm_transitions, event_name text, state_value_node_set text[], fsm_name_param text, fsm_version_param text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
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
	exit_result := fsm_core.compute_exit_actions_v2(transition_record := transition_record, input_state_node_set := state_value_node_set, input_fsm_name := transition_record.fsm_name, input_fsm_version := transition_record.fsm_version);
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

CREATE OR REPLACE FUNCTION fsm_core.resolve_state_value_v2(input_json jsonb, input_fsm_name text, input_fsm_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
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
    all_nodes := fsm_core.fsm_get_all_state_nodes_v2(input_state_paths := all_paths, input_fsm_name := input_fsm_name, input_fsm_version := input_fsm_version);

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

CREATE OR REPLACE FUNCTION fsm_core.resume_event_for_fsm_worker_v2(input_fsm_instance_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_fsm_name    text;
    v_fsm_version text;
BEGIN
    SELECT fsm_name, fsm_version
    INTO v_fsm_name, v_fsm_version
    FROM fsm_core.fsm_instance
    WHERE id = input_fsm_instance_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'status',          'fsm_not_found',
            'fsm_instance_id', input_fsm_instance_id
        );
    END IF;

    PERFORM fsm_core.enqueue_fsm_dispatch_v2(
        input_fsm_instance_id,
        v_fsm_name,
        v_fsm_version,
        'resume'
    );

    RETURN jsonb_build_object(
        'status',          'queued',
        'fsm_instance_id', input_fsm_instance_id,
        'fsm_name',        v_fsm_name,
        'fsm_version',     v_fsm_version
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.schedule_all_pending(input_stale_threshold_seconds integer DEFAULT 30)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
  WHILE fsm_core.schedule_next_pending(input_stale_threshold_seconds) LOOP
    NULL;
  END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.schedule_next_pending(input_stale_threshold_seconds integer DEFAULT 30)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_entry_id          uuid;
  v_instance_id       uuid;
  v_fsm_name          text;
  v_fsm_version       text;
  v_chosen_fsmlet_id  uuid;
BEGIN
  -- Step 1: claim the oldest pending entry (SKIP LOCKED = safe for parallel schedulers).
  SELECT fsm_instance_and_fsm_workerlet_id, fsm_instance_id, fsm_name, fsm_version
  INTO v_entry_id, v_instance_id, v_fsm_name, v_fsm_version
  FROM fsm_core.fsm_instance_and_fsm_workerlet
  WHERE status = 'pending'
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_entry_id IS NULL THEN
    RETURN false;
  END IF;

  -- Step 2: pick the best available fsmlet.
  --   Filter: heartbeat within threshold (node is alive)
  --           AND fsm_modules contains this fsm_name+version
  --           AND active_workers < max_concurrency (has a free slot)
  --   Score:  most available slots first (max_concurrency - active_workers DESC)
  SELECT fsm_workerlet_id
  INTO v_chosen_fsmlet_id
  FROM fsm_core.fsm_workerlet
  WHERE
    last_heartbeat > NOW() - (input_stale_threshold_seconds || ' seconds')::interval
    AND active_workers < max_concurrency
    AND fsm_modules @> jsonb_build_array(
          jsonb_build_object('fsm_name', v_fsm_name, 'fsm_version', v_fsm_version)
        )
  ORDER BY (max_concurrency - active_workers) DESC
  LIMIT 1;

  IF v_chosen_fsmlet_id IS NULL THEN
    -- No capable fsmlet right now — leave status=pending, retry on next cycle.
    RETURN false;
  END IF;

  -- Step 3: assign the entry to the chosen fsmlet.
  UPDATE fsm_core.fsm_instance_and_fsm_workerlet
  SET
    status              = 'scheduled',
    fsm_workerlet_id = v_chosen_fsmlet_id,
    scheduled_at        = NOW()
  WHERE fsm_instance_and_fsm_workerlet_id = v_entry_id;

  -- Step 4: wake the fsmlet via pg_notify.
  PERFORM pg_notify('fsm_fsmlet_work_' || v_chosen_fsmlet_id::text, v_instance_id::text);

  RETURN true;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.select_all_transitions_v2(event_name text, input_state_value text[], fsm_name_param text, fsm_version_param text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
	transitions JSONB;
BEGIN
	transitions := (
		SELECT jsonb_agg(t)
		FROM (
			SELECT * FROM fsm_core.fsm_transitions
			WHERE event_type = event_name
			  AND computed_sanitized_source_ltree::text = ANY(input_state_value)
			  AND fsm_name = fsm_name_param
			  AND fsm_version = fsm_version_param
		) t
	);
	IF transitions IS NULL THEN
		transitions := '[]'::jsonb;
	END IF;
	RETURN transitions;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.send_event_to_fsm_queue_with_event_logs_v2(input_fsm_instance_id uuid, input_fsm_instance_id_fsm_type text, input_fsm_instance_id_fsm_version text, input_send_to_parent_queue_id uuid, input_send_to_parent_queue_type text, input_send_to_parent_queue_id_event_name text, input_event_name text, input_event_action_type text, input_event_data jsonb, input_event_delay integer DEFAULT 0, input_event_status text DEFAULT 'ACTIVE'::text, input_event_output jsonb DEFAULT '{}'::jsonb, input_error_message text DEFAULT NULL::text, input_execution_started_at timestamp with time zone DEFAULT now(), input_execution_duration integer DEFAULT NULL::integer, input_execution_finished_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
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
        'eventData', jsonb_build_object(
            'eventType',    input_event_name,
            'eventPayload', input_event_data,
            'actionType',   input_event_action_type
        ),
        'queueId',                    input_fsm_instance_id,
        'queueType',                  input_fsm_instance_id_fsm_type,
        'queueVersion',               input_fsm_instance_id_fsm_version,
        'sendToParentQueueId',        input_send_to_parent_queue_id,
        'sendToParentQueueType',      input_send_to_parent_queue_type,
        'sendToParentQueueIdEventName', input_send_to_parent_queue_id_event_name
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

    -- Append queueMsgId to queue_msg_data
    queue_msg_data := queue_msg_data || jsonb_build_object('queueMsgId', output_fsm_instance_queue_msg_id);

    -- Append queueMsgDelay to queue_msg_data
    queue_msg_data := queue_msg_data || jsonb_build_object('queueMsgDelay', input_event_delay);

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

CREATE OR REPLACE FUNCTION fsm_core.stop_event_for_fsm_worker_v2(input_fsm_instance_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    instance_row    fsm_core.fsm_instance%ROWTYPE;
    cancelled_count int;
    event_log_id    uuid;
BEGIN
    -- 1. Fetch instance row
    SELECT * INTO instance_row
    FROM fsm_core.fsm_instance
    WHERE id = input_fsm_instance_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'status',          'fsm_not_found',
            'fsm_instance_id', input_fsm_instance_id
        );
    END IF;

    -- 2. Guard: nothing to cancel if instance is in a terminal state
    --    (fsm_instance_status can be inspected here if needed in the future)

    -- 3. Cancel any pending or scheduled dispatch entry for this instance.
    DELETE FROM fsm_core.fsm_instance_and_fsm_workerlet
    WHERE fsm_instance_id = input_fsm_instance_id
      AND status IN ('pending', 'scheduled');
    GET DIAGNOSTICS cancelled_count = ROW_COUNT;

    -- 4. Log
    INSERT INTO fsm_core.fsm_instance_queue_event_logs (
        fsm_instance_id,
        event_name,
        event_status,
        event_data,
        execution_finished_at
    ) VALUES (
        input_fsm_instance_id,
        'stop_worker',
        'cancelled',
        jsonb_build_object(
            'triggered_by',    'stop_event_for_fsm_worker_v2',
            'cancelled_count', cancelled_count
        ),
        now()
    ) RETURNING fsm_instance_queue_event_log_id INTO event_log_id;

    -- 5. Return
    RETURN jsonb_build_object(
        'status',          CASE WHEN cancelled_count > 0 THEN 'cancelled' ELSE 'not_queued' END,
        'fsm_instance_id', input_fsm_instance_id,
        'cancelled_count', cancelled_count,
        'event_log_id',    event_log_id
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.unlock_fsm_instance(input_fsm_instance_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fsm_core', 'pgmq', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    updated_count INTEGER;
BEGIN
    UPDATE fsm_core.fsm_instance
    SET
        worker_locked          = FALSE,
        worker_locked_by       = NULL,
        worker_locked_at       = NULL,
        worker_lock_expires_at = NULL
    WHERE id = input_fsm_instance_id
      AND worker_locked = TRUE;

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count > 0;
END;
$function$
;

grant select on table "fsm_core"."async_operation_meta" to "fsm_operator";

grant delete on table "fsm_core"."async_operation_workerlet" to "fsm_worker";

grant insert on table "fsm_core"."async_operation_workerlet" to "fsm_worker";

grant select on table "fsm_core"."async_operation_workerlet" to "fsm_worker";

grant update on table "fsm_core"."async_operation_workerlet" to "fsm_worker";

grant select on table "fsm_core"."fsm_instance" to "fsm_operator";

grant select on table "fsm_core"."fsm_json" to "fsm_admin";

grant select on table "fsm_core"."fsm_json" to "fsm_worker";

grant delete on table "fsm_core"."fsm_workerlet" to "fsm_worker";

grant insert on table "fsm_core"."fsm_workerlet" to "fsm_worker";

grant select on table "fsm_core"."fsm_workerlet" to "fsm_worker";

grant update on table "fsm_core"."fsm_workerlet" to "fsm_worker";

-- ── Hand-written (#469): not captured by `supabase db diff` ─────────────────
-- Copied verbatim from supabase/schemas/40_access_control/20261005120100_fsm_core_access_control.sql
-- (function EXECUTE grants/revokes, schema USAGE, pgmq). The diffed table
-- grants above are repeated by this block; GRANT is idempotent.

-- ── Nothing in fsm_core is executable by PUBLIC ─────────────────────────────
-- Skips functions that belong to an extension (pg_jsonschema installs into
-- fsm_core and is owned by its installer, not us).
DO $$
DECLARE
  fn regprocedure;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    WHERE p.pronamespace = 'fsm_core'::regnamespace
      AND p.proowner = current_user::regrole
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
                        AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn);
  END LOOP;
END;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA fsm_core TO fsm_operator, fsm_admin, fsm_worker, fsm_authenticator;

-- fsm_authenticator: only key verification
GRANT EXECUTE ON FUNCTION fsm_core.verify_api_key TO fsm_authenticator;

-- fsm_operator
GRANT EXECUTE ON FUNCTION
  fsm_core.create_fsm_instance_from_name_v2,
  fsm_core.send_event_to_fsm_queue_with_event_logs_v2,
  fsm_core.stop_event_for_fsm_worker_v2,
  fsm_core.resume_event_for_fsm_worker_v2,
  fsm_core.enqueue_fsm_dispatch_v2,
  fsm_core.get_fsm_data_resolve_state_value_v2
TO fsm_operator;
GRANT SELECT ON fsm_core.fsm_instance, fsm_core.async_operation_meta TO fsm_operator;

-- fsm_admin (inherits fsm_operator)
GRANT EXECUTE ON FUNCTION
  fsm_core.load_fsm_from_json_v2,
  fsm_core.load_fsm_state_from_json_v2,
  fsm_core.load_fsm_transition_from_json_v2,
  fsm_core.create_api_key,
  fsm_core.revoke_api_key,
  fsm_core.list_api_keys
TO fsm_admin;
GRANT SELECT ON fsm_core.fsm_json TO fsm_admin;

-- fsm_worker
GRANT EXECUTE ON FUNCTION
  fsm_core.claim_scheduled_for_fsmlet,
  fsm_core.schedule_next_pending,
  fsm_core.schedule_all_pending,
  fsm_core.microstep_v2,
  fsm_core.select_all_transitions_v2,
  fsm_core.resolve_state_value_v2,
  fsm_core.lock_fsm_instance,
  fsm_core.unlock_fsm_instance,
  fsm_core.archive_event_from_fsm_type_worker_v2,
  fsm_core.check_registry_for_async_actors,
  fsm_core.ensure_async_operation_queue_for_worker_v2,
  fsm_core.claim_pending_async_operation_events_for_workers_v2,
  fsm_core.claim_pending_async_operation_events_with_capacity_v2,
  fsm_core.compute_async_operation_queue_name_v2,
  fsm_core.archive_event_from_fsm_async_operation_type_worker_v2,
  fsm_core.load_async_operation_meta_v2,
  fsm_core.async_operation_schedule_next_pending,
  fsm_core.claim_scheduled_for_async_operation_workerlet,
  fsm_core.get_fsm_data_resolve_state_value_v2
TO fsm_worker;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON fsm_core.fsm_workerlet, fsm_core.async_operation_workerlet TO fsm_worker;
GRANT SELECT ON fsm_core.fsm_json TO fsm_worker;
-- The fsmlet reads its instance queue with pgmq.read(). Queue tables are
-- created at runtime by the (definer) instance functions, owned by the schema
-- owner, so grant through default privileges as well as on existing tables.
GRANT USAGE ON SCHEMA pgmq TO fsm_worker;
GRANT SELECT, UPDATE ON ALL TABLES IN SCHEMA pgmq TO fsm_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgmq GRANT SELECT, UPDATE ON TABLES TO fsm_worker;
