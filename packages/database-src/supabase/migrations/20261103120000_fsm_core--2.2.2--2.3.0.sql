-- fsm_core 2.2.2 -> 2.3.0 (SPEC-016, #688). Hand-written: function grants,
-- SECURITY DEFINER settings and the cron.schedule() call aren't captured by
-- `supabase db diff` (database-src/CLAUDE.md, "Access control").
--
-- - fsm_core.version() and fsm_core.require_version(): the database records its
--   version; upgrade scripts from here on start with require_version().
-- - The pg_cron job becomes part of the install: scheduler_job_status_v2() and
--   register_scheduler_job_v2() (SECURITY DEFINER, for fsm_admin), and the
--   job is registered here, so `supabase db reset` (and the full install)
--   leave a database with its scheduler running. pg_cron is required.
-- - The PUBLIC EXECUTE revoke no longer skips fsm_core's own extension
--   members: in the PGXN form (CREATE EXTENSION fsm_core) every function is
--   one, so none had been revoked.
-- - pg_jsonschema becomes optional: fsm_core.load_fsm_from_json_v2() skips its
--   (warning-only) schema check where the extension isn't installed.

-- ── Version ────────────────────────────────────────────────────────────────
create or replace function fsm_core.version()
returns text
language sql
immutable
as $$
  select '2.3.0'::text
$$;

create or replace function fsm_core.require_version(input_expected text)
returns void
language plpgsql
as $$
declare
  found text;
begin
  begin
    found := fsm_core.version();
  exception when undefined_function then
    found := null;
  end;
  if found is distinct from input_expected then
    raise exception 'fsm_core % required, found %', input_expected,
      coalesce(found, 'a version before 2.3.0 (no fsm_core.version())')
      using hint = 'Apply the upgrade scripts in order, starting from the installed version.';
  end if;
end;
$$;

-- ── The pg_cron job ────────────────────────────────────────────────────────
create or replace function fsm_core.scheduler_job_status_v2()
returns jsonb
language plpgsql
as $$
declare
  job record;
begin
  select jobid, schedule, command, active
    into job
    from cron.job
   where jobname = 'fsm_schedule_all_pending';
  if not found then
    return jsonb_build_object('jobname', 'fsm_schedule_all_pending', 'registered', false);
  end if;
  return jsonb_build_object(
    'jobname', 'fsm_schedule_all_pending',
    'registered', true,
    'jobid', job.jobid,
    'schedule', job.schedule,
    'command', job.command,
    'active', job.active
  );
end;
$$;

-- Idempotent: cron.schedule() errors on a duplicate jobname, so an existing
-- job is unscheduled first.
create or replace function fsm_core.register_scheduler_job_v2(
  input_schedule text default '5 seconds'
)
returns jsonb
language plpgsql
as $$
begin
  if exists (select 1 from cron.job where jobname = 'fsm_schedule_all_pending') then
    perform cron.unschedule('fsm_schedule_all_pending');
  end if;
  perform cron.schedule(
    'fsm_schedule_all_pending',
    input_schedule,
    'SELECT fsm_core.schedule_all_pending();'
  );
  return fsm_core.scheduler_job_status_v2();
end;
$$;

-- ── pg_jsonschema optional ─────────────────────────────────────────────────
-- load_fsm_from_json_v2 calls jsonschema_validation_errors() only where
-- pg_jsonschema is installed; the full install doesn't create it.
-- CREATE OR REPLACE resets SECURITY DEFINER and search_path, so they're set
-- again below (the grants are kept).
CREATE OR REPLACE FUNCTION fsm_core.load_fsm_from_json_v2(json_input JSONB, root_node_text TEXT, input_fsm_name TEXT, input_fsm_version TEXT, input_dependent_children JSONB DEFAULT NULL) RETURNS JSONB AS $$
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

    -- pg_jsonschema is optional (SPEC-016): the full install doesn't create
    -- it, so the check runs only where it's installed. It only warns either
    -- way; @pgfsm/compiler validates the JSON before it gets here.
    IF to_regprocedure('fsm_core.jsonschema_validation_errors(json, json)') IS NOT NULL THEN
        schema_errors := fsm_core.jsonschema_validation_errors(schema_json, json_input::JSON);
    END IF;
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
$$ LANGUAGE plpgsql;

-- ── Access (from 40_access_control) ────────────────────────────────────────
-- ── Nothing in fsm_core is executable by PUBLIC ─────────────────────────────
-- Skips functions that belong to another extension (pg_jsonschema installs
-- into fsm_core and is owned by its installer, not us). Members of fsm_core
-- itself, in its PGXN form (CREATE EXTENSION fsm_core), are included.
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
                      JOIN pg_extension e ON e.oid = d.refobjid
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
                        AND d.deptype = 'e' AND e.extname <> 'fsm_core')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn);
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION
  fsm_core.version(),
  fsm_core.require_version(text),
  fsm_core.scheduler_job_status_v2(),
  fsm_core.register_scheduler_job_v2(text)
FROM PUBLIC;
ALTER FUNCTION fsm_core.load_fsm_from_json_v2 SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.scheduler_job_status_v2 SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.register_scheduler_job_v2 SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
GRANT EXECUTE ON FUNCTION
  fsm_core.scheduler_job_status_v2,
  fsm_core.register_scheduler_job_v2
TO fsm_admin;
GRANT EXECUTE ON FUNCTION fsm_core.version() TO fsm_operator, fsm_worker, fsm_authenticator;

-- ── Register the job (idempotent) ──────────────────────────────────────────
SELECT fsm_core.register_scheduler_job_v2();
