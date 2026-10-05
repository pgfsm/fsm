-- fsm_core access control (SPEC-009 §1, #469)
--
-- Four roles, enforced at the function boundary (database ADR-001):
--
--   fsm_operator       NOLOGIN  instance commands (create/send/stop/resume) and
--                               instance reads — the /fsm/* API routes and
--                               `pgfsmctl instance …`
--   fsm_admin          NOLOGIN  fsm_operator + loading FSM definitions + API-key
--                               management
--   fsm_worker         NOLOGIN  the fsmlet, `pgfsmctl scheduler run` and the
--                               Activity Gateway: claim / dispatch / archive /
--                               heartbeat, and pgmq reads of instance queues
--   fsm_authenticator  LOGIN, NOINHERIT, no password — the REST API's pool
--                               login. Holds no rights itself; the API does
--                               SET LOCAL ROLE fsm_operator|fsm_admin per
--                               request after verify_api_key(). It is a member
--                               of fsm_operator only: a deployment that runs
--                               the admin API grants fsm_admin to it (or to a
--                               separate login), never this migration.
--
-- Deployments create their own logins and grant one of these roles to them,
-- e.g. CREATE ROLE gateway LOGIN PASSWORD '…' IN ROLE fsm_worker. The schema
-- owner (postgres) keeps doing migrations and pg_cron registration.
--
-- How enforcement works: the entry-point functions TypeScript calls run as
-- SECURITY DEFINER (owner = postgres) with a pinned search_path, so a role
-- needs only EXECUTE on them, not table access. Roles get table privileges
-- only for the few tables @pgfsm/db reads or writes directly (workerlet
-- heartbeats, instance listing, fsm_json reads), listed below.
--
-- NOT captured by `supabase db diff`: CREATE ROLE, GRANT and REVOKE are not
-- schema objects, so the diff drops them (same reason the pg_cron job never
-- reached migrations, #468). This file is the source of truth; the matching
-- block is appended by hand to the versioned migration, and the pgTAP test
-- tests/40_access_control/ fails if the two drift. When you add a function
-- TypeScript calls, add it to the right ALTER/GRANT list here AND to a new
-- migration — the pgTAP test fails on any fsm_core function executable by
-- PUBLIC.
--
-- Why no ALTER DEFAULT PRIVILEGES: per-schema default privileges can only add
-- to the global defaults, never remove EXECUTE from PUBLIC, and a global
-- revoke would also hit the owner's functions outside fsm_core. The explicit
-- REVOKE below plus the pgTAP test do that job instead.

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

-- ── Entry points run as the owner ───────────────────────────────────────────
-- search_path: fsm_core (own objects, pg_jsonschema), pgmq, public (ltree),
-- extensions (Supabase's extension schema; ignored where it doesn't exist),
-- pg_temp last so a temp object can't shadow anything.

-- worker
ALTER FUNCTION fsm_core.claim_scheduled_for_fsmlet SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.schedule_next_pending SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.schedule_all_pending SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.microstep_v2 SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.select_all_transitions_v2 SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.resolve_state_value_v2 SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.lock_fsm_instance SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.unlock_fsm_instance SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.archive_event_from_fsm_type_worker_v2 SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.check_registry_for_async_actors SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.ensure_async_operation_queue_for_worker_v2 SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.claim_pending_async_operation_events_for_workers_v2 SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.claim_pending_async_operation_events_with_capacity_v2 SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.compute_async_operation_queue_name_v2 SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.archive_event_from_fsm_async_operation_type_worker_v2 SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.load_async_operation_meta_v2 SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.async_operation_schedule_next_pending SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.claim_scheduled_for_async_operation_workerlet SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
-- operator (get_fsm_data_resolve_state_value_v2 is also used by the fsmlet)
ALTER FUNCTION fsm_core.create_fsm_instance_from_name_v2 SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.send_event_to_fsm_queue_with_event_logs_v2 SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.stop_event_for_fsm_worker_v2 SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.resume_event_for_fsm_worker_v2 SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.enqueue_fsm_dispatch_v2 SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.get_fsm_data_resolve_state_value_v2 SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
-- admin
ALTER FUNCTION fsm_core.load_fsm_from_json_v2 SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.load_fsm_state_from_json_v2 SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;
ALTER FUNCTION fsm_core.load_fsm_transition_from_json_v2 SECURITY DEFINER SET search_path = fsm_core, pgmq, public, extensions, pg_temp;

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
