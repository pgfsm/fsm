# CLAUDE.md — DB Helpers (`packages/fsm-core-db-ts/`)

Scoped guidance for the raw pg client helpers. Repo-wide conventions and session
protocol live in the root `CLAUDE.md` / `AGENTS.md`.

## Structure (`src/`)

- `fsm-helper.ts` — load states/transitions from JSON, DB queries
- `fsm-definition.ts` — FSM definitions as a deploy artifact (SPEC-006):
  `fsmJsonDigest`/`canonicalizeFsmJson` (RFC 8785 + SHA-256, shared by the
  compiler and the fsmlet), `getFsmJsonForFsmModules`,
  `extractFsmDependentChildren`, and `loadFsmDefinitions` (validate, children
  first, one transaction; behind `pgfsmctl fsm load`). Tests in
  `test/fsm-definition.test.ts` (`deno task test`; DB tests need `DATABASE_URL`)
- `fsm-instance-lock.ts` — advisory lock concurrency control
- `queue.ts` — pgmq-based event queue management
- `35_fsm_sync_operation_worker_v1/fsmSyncOperationWorkerlet.ts` —
  `fsm_workerlet` table ops for the fsmlet node-agent (dispatch-queue worker
  model)
- `35_fsm_sync_operation_worker_v1/fsmctl.ts` — FSM instance lifecycle (list,
  create, get, stop), archive/send events, and dispatch enqueue/resume ops
  (behind `pgfsmctl instance …`, `@pgfsm/ctl`)
- `35_fsm_sync_operation_worker_v1/fsmSyncOperationScheduler.ts` —
  dispatch-queue scheduling op (`schedule_next_pending`) and the
  `fsm_schedule_all_pending` pg_cron job's register/unregister/get helpers
  (behind `pgfsmctl pgcron …`)
- `25_async_operation_worker_v1/asyncOperationWorkerCtl.ts` — async-operation
  dispatch-table ops (promise/callback workflows)
- `25_async_operation_worker_v1/asyncOperationMeta.ts` — `async_operation_meta`
  load op
- `25_async_operation_worker_v1/asyncOperationScheduler.ts` — dispatch-queue
  scheduling op (`async_operation_schedule_next_pending`)
- `25_async_operation_worker_v1/asyncOperationHelper.ts` — actor registry checks
  (`check_registry_for_async_actors`,
  `check_registry_and_working_for_async_actors_for_fsm_instance_and_worklet`)
- `25_async_operation_worker_v1/asyncOperationWorkerlet.ts` —
  `async_operation_workerlet` table ops for the async-operation node-agent
- `30_async_operation_worker_v2/asyncOperationWorker.ts` —
  `claimPendingAsyncOperationEventsForWorkers` (PGMQ async-operation-queue
  polling) and `ensureAsyncOperationQueueForWorker` (PGMQ async-operation-queue
  creation)
- `30_async_operation_worker_v2/asyncOperationCtl.ts` —
  `archiveEventFromFsmAsyncOperationTypeWorker`
- `pg-utils.ts` — small pg param helpers (e.g. `toJsonbParam`)
- `const.ts` — schema/table name constants (`FSM_SCHEMA`,
  `FSM_SCHEMA_FN_VERSION`, `QUEUE_SCHEMA`, …)
- `custom.types.ts` — shared types (e.g. `DBDeps`)
- `index.ts` — public barrel export; this package is a library and only calls
  `getLogger()` — logging is configured once by the host process (see
  `packages/fsm-logging-ts/CLAUDE.md`)

## Naming Conventions

PostgreSQL is the source of truth. TypeScript wrappers here must stay aligned
with PG function names and parameter names.

### PG → TS Function Name Rules

- Strip `_v1` / `_v2` version suffix from TS names — version is driven by
  `FSM_SCHEMA_FN_VERSION = "v2"` in `const.ts`
- Use camelCase matching the PG snake_case name (e.g.,
  `archive_event_from_fsm_type_worker_v2` → `archiveEventFromFsmTypeWorker`)
- No added verbs or abbreviations not in the PG name

### Parameter Name Rules (PG schema)

- All PG function parameters use `input_*` prefix (e.g., `input_fsm_name`,
  `input_state_value`)
- Exception: internal orchestration params keep their names (e.g.,
  `fsm_name_param`, `event_name`, `transition_record`)
- v1 functions still use `p_*` prefix — not to be changed (superseded by v2)

### Reference Document

See `packages/database-src/docs/reference/pg-ts-function-mapping.md` for the
complete PG→TS function mapping table, including:

- All 18 direct 1:1 mappings (Table 1)
- TS functions not directly mapped to a PG function (Table 2)
- Gap: PG functions with no TS wrapper (Table 3)
