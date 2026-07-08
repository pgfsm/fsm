drop function if exists "fsm_core"."load_fsm_from_json_v2"(json_input jsonb, root_node_text text, input_fsm_type text, input_fsm_name text, input_fsm_version text);

create table "fsm_core"."async_operation_instance_and_async_operation_workerlet" (
    "async_operation_instance_and_async_operation_workerlet_id" uuid not null default gen_random_uuid(),
    "async_operation_instance_id" uuid not null,
    "async_operation_workerlet_id" uuid,
    "async_operation_name" text not null,
    "async_operation_version" text not null,
    "async_operation_type" text not null,
    "parent_fsm_name" text not null,
    "parent_fsm_version" text not null,
    "async_operation_language" text not null,
    "status" text not null default 'pending'::text,
    "created_at" timestamp with time zone not null default now(),
    "scheduled_at" timestamp with time zone
);


create table "fsm_core"."async_operation_meta" (
    "async_operation_meta_id" uuid not null default gen_random_uuid(),
    "async_operation_name" text not null,
    "async_operation_type" text not null,
    "async_operation_version" text not null,
    "parent_fsm_name" text not null,
    "parent_fsm_version" text not null,
    "max_concurrency" integer not null default 8,
    "async_operation_language" text not null,
    "updated_at" timestamp with time zone not null default now(),
    "updated_by_pid" text not null
);


create table "fsm_core"."async_operation_workerlet" (
    "async_operation_workerlet_id" uuid not null default gen_random_uuid(),
    "async_operation_workerlet_pid" text not null,
    "supported_async_operations" jsonb not null default '[]'::jsonb,
    "max_pid_number" integer not null,
    "active_pid_number" integer not null default 0,
    "last_heartbeat" timestamp with time zone not null default now(),
    "registered_at" timestamp with time zone not null default now()
);


create table "fsm_core"."fsm_dependencies" (
    "parent_fsm_name" text not null,
    "parent_fsm_version" text not null,
    "child_fsm_name" text not null,
    "child_fsm_version" text not null
);


create table "fsm_core"."fsm_instance_and_fsm_workerlet" (
    "fsm_instance_and_fsm_workerlet_id" uuid not null default gen_random_uuid(),
    "fsm_instance_id" uuid not null,
    "fsm_workerlet_id" uuid,
    "fsm_name" text not null,
    "fsm_version" text not null,
    "dispatch_type" text not null default 'start'::text,
    "status" text not null default 'pending'::text,
    "created_at" timestamp with time zone not null default now(),
    "scheduled_at" timestamp with time zone
);


create table "fsm_core"."fsm_workerlet" (
    "fsm_workerlet_id" uuid not null default gen_random_uuid(),
    "fsm_workerlet_pid" text not null,
    "fsm_modules" jsonb not null default '[]'::jsonb,
    "max_concurrency" integer not null,
    "active_workers" integer not null default 0,
    "last_heartbeat" timestamp with time zone not null default now(),
    "registered_at" timestamp with time zone not null default now()
);


alter table "fsm_core"."fsm_instance" add column "worker_lock_expires_at" timestamp with time zone;

alter table "fsm_core"."fsm_instance" add column "worker_locked" boolean default false;

alter table "fsm_core"."fsm_instance" add column "worker_locked_at" timestamp with time zone;

alter table "fsm_core"."fsm_instance" add column "worker_locked_by" text;

alter table "fsm_core"."fsm_json" alter column "fsm_json" set data type jsonb using "fsm_json"::jsonb;

CREATE UNIQUE INDEX async_operation_instance_and_async_operation_workerlet_pkey ON fsm_core.async_operation_instance_and_async_operation_workerlet USING btree (async_operation_instance_and_async_operation_workerlet_id);

CREATE UNIQUE INDEX async_operation_meta_pkey ON fsm_core.async_operation_meta USING btree (async_operation_meta_id);

CREATE UNIQUE INDEX async_operation_meta_unique ON fsm_core.async_operation_meta USING btree (async_operation_name, async_operation_version, async_operation_type, parent_fsm_name, parent_fsm_version);

CREATE UNIQUE INDEX async_operation_workerlet_pkey ON fsm_core.async_operation_workerlet USING btree (async_operation_workerlet_id);

CREATE UNIQUE INDEX fsm_dependencies_pkey ON fsm_core.fsm_dependencies USING btree (parent_fsm_name, parent_fsm_version, child_fsm_name, child_fsm_version);

CREATE UNIQUE INDEX fsm_instance_and_fsm_workerlet_pkey ON fsm_core.fsm_instance_and_fsm_workerlet USING btree (fsm_instance_and_fsm_workerlet_id);

CREATE UNIQUE INDEX fsm_workerlet_pkey ON fsm_core.fsm_workerlet USING btree (fsm_workerlet_id);

CREATE INDEX idx_async_operation_instance_and_workerlet_pending ON fsm_core.async_operation_instance_and_async_operation_workerlet USING btree (created_at) WHERE (status = 'pending'::text);

CREATE INDEX idx_async_operation_instance_and_workerlet_scheduled ON fsm_core.async_operation_instance_and_async_operation_workerlet USING btree (async_operation_workerlet_id) WHERE (status = 'scheduled'::text);

CREATE INDEX idx_fsm_instance_and_fsm_workerlet_pending ON fsm_core.fsm_instance_and_fsm_workerlet USING btree (created_at) WHERE (status = 'pending'::text);

CREATE INDEX idx_fsm_instance_and_fsm_workerlet_scheduled ON fsm_core.fsm_instance_and_fsm_workerlet USING btree (fsm_workerlet_id) WHERE (status = 'scheduled'::text);

alter table "fsm_core"."async_operation_instance_and_async_operation_workerlet" add constraint "async_operation_instance_and_async_operation_workerlet_pkey" PRIMARY KEY using index "async_operation_instance_and_async_operation_workerlet_pkey";

alter table "fsm_core"."async_operation_meta" add constraint "async_operation_meta_pkey" PRIMARY KEY using index "async_operation_meta_pkey";

alter table "fsm_core"."async_operation_workerlet" add constraint "async_operation_workerlet_pkey" PRIMARY KEY using index "async_operation_workerlet_pkey";

alter table "fsm_core"."fsm_dependencies" add constraint "fsm_dependencies_pkey" PRIMARY KEY using index "fsm_dependencies_pkey";

alter table "fsm_core"."fsm_instance_and_fsm_workerlet" add constraint "fsm_instance_and_fsm_workerlet_pkey" PRIMARY KEY using index "fsm_instance_and_fsm_workerlet_pkey";

alter table "fsm_core"."fsm_workerlet" add constraint "fsm_workerlet_pkey" PRIMARY KEY using index "fsm_workerlet_pkey";

alter table "fsm_core"."async_operation_meta" add constraint "async_operation_meta_unique" UNIQUE using index "async_operation_meta_unique";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.async_operation_schedule_next_pending(input_stale_threshold_seconds integer DEFAULT 30)
 RETURNS boolean
 LANGUAGE plpgsql
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
  PERFORM pg_notify(
    'async_operation_workerlet_work_' || v_chosen_workerlet_id::text,
    v_instance_id::text
  );

  RETURN true;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.check_fsm_circular_dependency()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    loop_detected BOOLEAN;
BEGIN
    IF NEW.parent_fsm_name = NEW.child_fsm_name
       AND NEW.parent_fsm_version = NEW.child_fsm_version THEN
        RAISE EXCEPTION 'Circular dependency: FSM (% %) cannot depend on itself.',
            NEW.parent_fsm_name, NEW.parent_fsm_version;
    END IF;

    -- Walk downstream from NEW.child; if we reach NEW.parent a cycle exists.
    WITH RECURSIVE fsm_graph AS (
        SELECT child_fsm_name, child_fsm_version
        FROM fsm_core.fsm_dependencies
        WHERE parent_fsm_name    = NEW.child_fsm_name
          AND parent_fsm_version = NEW.child_fsm_version

        UNION ALL

        SELECT d.child_fsm_name, d.child_fsm_version
        FROM fsm_core.fsm_dependencies d
        JOIN fsm_graph g
          ON d.parent_fsm_name    = g.child_fsm_name
         AND d.parent_fsm_version = g.child_fsm_version
    )
    SELECT EXISTS (
        SELECT 1 FROM fsm_graph
        WHERE child_fsm_name    = NEW.parent_fsm_name
          AND child_fsm_version = NEW.parent_fsm_version
    ) INTO loop_detected;

    IF loop_detected THEN
        RAISE EXCEPTION 'Circular dependency: linking (% %) -> (% %) creates an infinite loop.',
            NEW.parent_fsm_name, NEW.parent_fsm_version,
            NEW.child_fsm_name,  NEW.child_fsm_version;
    END IF;

    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.check_registry_for_async_actors(input_async_actors jsonb, input_fsm_name text, input_fsm_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
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

CREATE OR REPLACE FUNCTION fsm_core.claim_scheduled_for_fsmlet(input_fsmlet_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
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

CREATE OR REPLACE FUNCTION fsm_core.enqueue_fsm_dispatch_v1(input_instance_id text, input_fsm_name text, input_fsm_version text, input_dispatch_type text DEFAULT 'start'::text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  dispatch_queue_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'master_worker_dispatch_queue_start'
  ) INTO dispatch_queue_exists;

  IF NOT dispatch_queue_exists THEN
    PERFORM pgmq.create(queue_name := 'master_worker_dispatch_queue_start');
  END IF;

  PERFORM pgmq.send(
    queue_name := 'master_worker_dispatch_queue_start',
    msg        := jsonb_build_object(
      'id',          input_instance_id,
      'fsm_name',    input_fsm_name,
      'fsm_version', input_fsm_version
    )
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.enqueue_fsm_dispatch_v2(input_instance_id uuid, input_fsm_name text, input_fsm_version text, input_dispatch_type text DEFAULT 'start'::text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO fsm_core.fsm_instance_and_fsm_workerlet (fsm_instance_id, fsm_name, fsm_version, dispatch_type)
  VALUES (input_instance_id, input_fsm_name, input_fsm_version, input_dispatch_type);

  PERFORM pg_notify('fsm_scheduler_work', input_instance_id::text);
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.hello_niraj(input_text text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
    RAISE NOTICE 'Hello niraj, %!', input_text;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.insert_fsm_dependencies(p_parent_name text, p_parent_version text, p_dependent_children jsonb)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_child RECORD;
BEGIN
    FOR v_child IN
        SELECT fsm_name, fsm_version
        FROM jsonb_to_recordset(p_dependent_children)
             AS x(fsm_name TEXT, fsm_version TEXT)
    LOOP
        INSERT INTO fsm_core.fsm_dependencies
            (parent_fsm_name, parent_fsm_version, child_fsm_name, child_fsm_version)
        VALUES
            (p_parent_name, p_parent_version, v_child.fsm_name, v_child.fsm_version)
        ON CONFLICT DO NOTHING;
    END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.load_async_operation_meta_v2(input_async_operation_name text, input_async_operation_version text, input_async_operation_type text, input_async_operation_language text, input_parent_fsm_name text, input_parent_fsm_version text, input_updated_by_pid text)
 RETURNS jsonb
 LANGUAGE plpgsql
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
    parent_fsm_version
  ) VALUES (
    input_async_operation_name,
    input_async_operation_version,
    input_async_operation_type,
    input_async_operation_language,
    input_parent_fsm_name,
    input_parent_fsm_version
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

CREATE OR REPLACE FUNCTION fsm_core.load_fsm_from_json_v2(json_input jsonb, root_node_text text, input_fsm_type text, input_fsm_name text, input_fsm_version text, input_dependent_children jsonb DEFAULT NULL::jsonb)
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

    INSERT INTO fsm_core.fsm_json (fsm_name, fsm_type, fsm_version, fsm_json)
    VALUES (input_fsm_name, input_fsm_type, input_fsm_version, json_input);

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

CREATE OR REPLACE FUNCTION fsm_core.resume_event_for_fsm_worker_v2(input_fsm_instance_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
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

CREATE OR REPLACE FUNCTION fsm_core.schedule_next_pending(input_stale_threshold_seconds integer DEFAULT 30)
 RETURNS boolean
 LANGUAGE plpgsql
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

CREATE OR REPLACE FUNCTION fsm_core.stop_event_for_fsm_worker_v1(input_fsm_instance_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    instance_row  fsm_core.fsm_instance%ROWTYPE;
    unlock_result boolean;
    event_log_id  uuid;
BEGIN
    -- 1. Fetch instance row (carries worker lock columns)
    SELECT * INTO instance_row
    FROM fsm_core.fsm_instance
    WHERE id = input_fsm_instance_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'status',          'fsm_not_found',
            'fsm_instance_id', input_fsm_instance_id,
            'lock_record',     'null'::jsonb
        );
    END IF;

    -- 2. Worker is not running
    IF instance_row.worker_locked IS NOT TRUE THEN
        RETURN jsonb_build_object(
            'status',          'stopped_or_not_started',
            'fsm_instance_id', input_fsm_instance_id,
            'lock_record',     jsonb_build_object(
                'worker_locked',          instance_row.worker_locked,
                'worker_locked_by',       instance_row.worker_locked_by,
                'worker_locked_at',       instance_row.worker_locked_at,
                'worker_lock_expires_at', instance_row.worker_lock_expires_at
            )
        );
    END IF;

    -- 3. Unlock directly (avoids extra function-call round-trip)
    UPDATE fsm_core.fsm_instance
    SET
        worker_locked          = false,
        worker_locked_by       = NULL,
        worker_locked_at       = NULL,
        worker_lock_expires_at = NULL
    WHERE id = input_fsm_instance_id;
    unlock_result := FOUND;

    -- 4. pg_notify so the LISTEN connection wakes any live worker
    PERFORM pg_notify('fsm_worker_stop', input_fsm_instance_id::text);

    -- 5. Log to fsm_instance_queue_event_logs
    INSERT INTO fsm_core.fsm_instance_queue_event_logs (
        fsm_instance_id,
        event_name,
        event_status,
        event_data,
        execution_finished_at
    ) VALUES (
        input_fsm_instance_id,
        'stop_worker',
        'stopped',
        jsonb_build_object('triggered_by', 'stop_event_for_fsm_worker_v1'),
        now()
    ) RETURNING fsm_instance_queue_event_log_id INTO event_log_id;

    -- 6. Return
    RETURN jsonb_build_object(
        'status',          'stopped',
        'fsm_instance_id', input_fsm_instance_id,
        'unlock_result',   unlock_result,
        'event_log_id',    event_log_id,
        'lock_record',     jsonb_build_object(
            'worker_locked',          instance_row.worker_locked,
            'worker_locked_by',       instance_row.worker_locked_by,
            'worker_locked_at',       instance_row.worker_locked_at,
            'worker_lock_expires_at', instance_row.worker_lock_expires_at
        )
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION fsm_core.stop_event_for_fsm_worker_v2(input_fsm_instance_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
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
    fsm_instance_row      fsm_core.fsm_instance;
BEGIN
    -- 1. Check if fsm_name and fsm_version exist in fsm_core.fsm_json and get fsm_type
    SELECT fj.fsm_type INTO derived_fsm_type
    FROM fsm_core.fsm_json fj
    WHERE fj.fsm_name = input_fsm_name AND fj.fsm_version = input_fsm_version;

    IF derived_fsm_type IS NULL THEN
        RAISE EXCEPTION 'FSM with name % and version % not found in fsm_core.fsm_json', input_fsm_name, input_fsm_version;
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

CREATE OR REPLACE FUNCTION fsm_core.lock_fsm_instance(input_fsm_instance_id uuid, input_locked_by text)
 RETURNS boolean
 LANGUAGE plpgsql
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

CREATE OR REPLACE FUNCTION fsm_core.unlock_fsm_instance(input_fsm_instance_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
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

CREATE TRIGGER enforce_fsm_no_cycles BEFORE INSERT OR UPDATE ON fsm_core.fsm_dependencies FOR EACH ROW EXECUTE FUNCTION fsm_core.check_fsm_circular_dependency();


