# fsm-sync-worker-ts — CLI Usage Guide

This package provides four CLIs:

| CLI              | Entry point               | Role                                                                                                                          |
| ---------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **fsmlet**       | `src/cli/fsmlet.ts`       | Long-running node agent (kubelet equivalent) — registers itself, claims and drives FSM workers up to a concurrency limit      |
| **fsmscheduler** | `src/cli/fsmscheduler.ts` | Control-plane routing process (kube-scheduler equivalent) for `fsmlet` node agents. Run once per cluster, not on worker nodes |
| **fsmctl**       | `src/cli/fsmctl.ts`       | One-shot control CLI (kubectl equivalent) — create/resume/send/stop against the dispatch-queue model, then exits              |
| **pgcron**       | `src/cli/pgcron.ts`       | One-shot deploy-time script — (re)registers the `pg_cron` job that drains the dispatch queue on a timer                       |

> **Async-operation CLIs** (`async-operation-workerlet`,
> `async-operation-scheduler`, `async-operation-ctl`) live in the sibling
> package — see
> [`fsm-async-worker-ts/docs/guides/CLI-USAGE.md`](../../../fsm-async-worker-ts/docs/guides/CLI-USAGE.md).

---

## Prerequisites

1. **Deno** — see `.prototools` at the repo root for the pinned version
2. **Database connection** — one of:
   - `.env` file in the directory you run the CLI from, containing
     `DATABASE_URL=postgresql://...`
   - `--db-url` / `-d` flag passed directly (takes precedence over `.env`)
3. **FSM folder path** — path to the FSM definition folder tree (e.g.
   `apps/fsm-core-example/fsm`). Folders must contain subdirectories for
   `actions/`, `guards/`, `delays/`, and/or `actors/` with TypeScript module
   files.

---

## fsmlet — node agent

`fsmlet` is the long-running scheduler-aware agent (kubelet equivalent). It
validates FSM modules at startup, registers itself in `fsm_workerlet`, then
waits for the scheduler to route work to it via `pg_notify`. It drives multiple
FSM instances concurrently up to `--max-concurrency`.

### Invocation

```bash
# From repo root
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/fsmlet.ts \
  -f <fsm-folder-path> [options]
```

### Options

| Flag                       | Alias | Required | Default                    | Description                                                                 |
| -------------------------- | ----- | -------- | -------------------------- | --------------------------------------------------------------------------- |
| `--fsm-folder-path <path>` | `-f`  | yes      | —                          | Path to the FSM folder tree (validated at startup before any DB connection) |
| `--db-url <url>`           | `-d`  | no       | `DATABASE_URL` from `.env` | PostgreSQL connection string                                                |
| `--max-concurrency <n>`    | `-m`  | no       | `8`                        | Max FSM instances driven concurrently on this node                          |
| `--fsmlet-id <id>`         | `-i`  | no       | random UUID                | Stable identity across restarts — also read from `FSMLET_ID` env var        |
| `--version`                | `-v`  | —        | —                          | Print `@pgfsm/sync-worker`'s version and exit                               |
| `--help`                   | `-h`  | —        | —                          | Print help and exit                                                         |

### Example

```bash
# Minimal — reads DATABASE_URL from .env
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/fsmlet.ts \
  -f apps/fsm-core-example/fsm

# Full options
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/fsmlet.ts \
  -f apps/fsm-core-example/fsm \
  -d postgresql://user:pass@localhost:5432/db \
  -m 4 \
  -i my-node-01
```

### Startup sequence

1. **Validate** — runs `validateSyncOperationFromFolders` on the FSM folder;
   only modules that pass (`isFsmModuleVerified = true`) proceed.
2. **Register** — inserts this node into `fsm_workerlet` with the verified FSM
   list and `max-concurrency`.
3. **LISTEN** — opens a dedicated connection and subscribes to:
   - `fsm_fsmlet_work_<id>` — scheduler routes a work item here
   - `fsm_worker_stop` — abort a specific running instance
4. **Claim & dispatch** — on each notification, calls
   `claim_scheduled_for_fsmlet()` atomically, then starts an FSM worker (bounded
   by `--max-concurrency` via a semaphore).
5. **Heartbeat** — sends a heartbeat every 5 s so the scheduler can score this
   node.
6. **Fallback poll** — polls every 30 s to catch any `pg_notify` missed after a
   LISTEN connection drop.

### Graceful shutdown

| Signal                             | Behaviour                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Ctrl+C once** (SIGINT / SIGTERM) | Aborts all active workers, drains until they exit, deregisters from `fsm_workerlet`, closes the pool |
| **Ctrl+C twice**                   | Force-exit (`Deno.exit(0)`) — DB lock and registration are cleaned up by session-end                 |

### Environment variables

| Variable       | Description                                                        |
| -------------- | ------------------------------------------------------------------ |
| `DATABASE_URL` | Fallback DB connection string (used when `--db-url` is not passed) |
| `FSMLET_ID`    | Fallback stable identity (used when `--fsmlet-id` is not passed)   |

---

## fsmscheduler — control-plane routing process

`fsmscheduler` is the control-plane routing process (kube-scheduler equivalent)
for `fsmlet` node agents. It does not take a folder path or drive any FSM
instances itself — it only routes dispatch entries to the `fsmlet` nodes that
can handle them. Run it once per cluster, alongside the API server, **not** on a
machine also running `fsmlet`.

### Invocation

```bash
# From repo root
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/fsmscheduler.ts [options]
```

### Options

| Flag                    | Alias | Required | Default                    | Description                                                    |
| ----------------------- | ----- | -------- | -------------------------- | -------------------------------------------------------------- |
| `--db-url <url>`        | `-d`  | no       | `DATABASE_URL` from `.env` | PostgreSQL connection string (required — exits if unset)       |
| `--poll-interval <ms>`  | `-p`  | no       | `30000`                    | Fallback poll interval in milliseconds                         |
| `--stale-threshold <s>` | `-s`  | no       | `30`                       | Seconds before a `fsmlet` with no heartbeat is treated as dead |
| `--version`             | `-v`  | —        | —                          | Print `@pgfsm/sync-worker`'s version and exit                  |
| `--help`                | `-h`  | —        | —                          | Print help and exit                                            |

### Example

```bash
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/fsmscheduler.ts \
  -d postgresql://user:pass@localhost:5432/db \
  -p 30000 \
  -s 30
```

### Behavior

1. **LISTEN** — opens a dedicated connection and subscribes to
   `fsm_scheduler_work`.
2. **Scheduling cycle** — on each notification, loops
   `fsm_core.schedule_next_pending()` until the queue is empty or no `fsmlet`
   has capacity. Each call does a single-transaction claim
   (`SELECT FOR
   UPDATE SKIP LOCKED`), filters/scores active `fsmlet` nodes,
   assigns the winner, and `pg_notify`s it — all inside the PG function.
3. **Initial cycle** — runs one scheduling cycle immediately on startup, in case
   entries were enqueued before the process started.
4. **Fallback poll** — every 30 s by default (`--poll-interval`), runs another
   cycle to catch any `pg_notify` missed after a `LISTEN` connection drop.

### Graceful shutdown

| Signal                             | Behaviour                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| **Ctrl+C once** (SIGINT / SIGTERM) | Stops the fallback poll loop, releases the LISTEN connection, closes the pool |
| **Ctrl+C twice**                   | Force-exit (`Deno.exit(0)`)                                                   |

### Environment variables

| Variable       | Description                                                        |
| -------------- | ------------------------------------------------------------------ |
| `DATABASE_URL` | Fallback DB connection string (used when `--db-url` is not passed) |

---

## fsmctl — one-shot control CLI

`fsmctl` is the one-shot control CLI (kubectl equivalent) for the dispatch-queue
model. It issues a single command against the database and exits immediately —
it does not run a polling loop or drive a worker itself. `create` and `resume`
enqueue a dispatch entry and `pg_notify` the `fsmscheduler`; an actual `fsmlet`
still has to pick the work up.

### Invocation

```bash
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/fsmctl.ts -c <command> [options]
```

### Commands

| Command  | Required flags                         | Description                                                                               |
| -------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `create` | `-n, --fsm-name`, `-V, --fsm-version`  | Create a new FSM instance and enqueue it to `fsm_dispatch_queue` for the `fsmscheduler`   |
| `resume` | `-q, --queue-name`                     | Enqueue an existing FSM instance to `fsm_dispatch_queue` for resumption                   |
| `send`   | `-q, --queue-name`, `-e, --event-type` | Send an event to a running FSM instance                                                   |
| `stop`   | `-q, --queue-name`                     | Send a stop signal to whichever `fsmlet` worker is running that instance, via `pg_notify` |

`-q, --queue-name` takes the FSM instance ID (a UUID), not a PGMQ queue name —
the flag name is a holdover from the pre-scheduler model.

### Options

| Flag                  | Alias | Description                                                                      |
| --------------------- | ----- | -------------------------------------------------------------------------------- |
| `--command <command>` | `-c`  | Command to run — `create` / `resume` / `send` / `stop` (required)                |
| `--fsm-name <name>`   | `-n`  | FSM definition name (required for `create`)                                      |
| `--fsm-version <ver>` | `-V`  | FSM version (required for `create`)                                              |
| `--context <json>`    |       | Initial FSM context as a JSON string (optional, `create` only; defaults to `{}`) |
| `--queue-name <id>`   | `-q`  | FSM instance ID (required for `resume`, `send`, `stop`)                          |
| `--event-type <type>` | `-e`  | Event type to send (required for `send`)                                         |
| `--event-data <json>` |       | Event payload as a JSON string (optional, `send` only)                           |
| `--db-url <url>`      | `-d`  | PostgreSQL connection string (overrides `DATABASE_URL` from `.env`)              |
| `--version`           | `-v`  | Print `@pgfsm/sync-worker`'s version and exit                                    |
| `--help`              | `-h`  | Print help and exit                                                              |

### Examples

```bash
# Create a new FSM instance (prints the instance UUID to stdout)
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/fsmctl.ts \
  -c create -n creditCheck -V 1

# ...with initial context
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/fsmctl.ts \
  -c create -n creditCheck -V 1 --context '{"userId":"abc"}'

# Resume an existing instance
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/fsmctl.ts \
  -c resume -q <instance-uuid>

# Send an event
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/fsmctl.ts \
  -c send -q <instance-uuid> -e APPROVE

# ...with an event payload
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/fsmctl.ts \
  -c send -q <instance-uuid> -e APPROVE --event-data '{"reason":"ok"}'

# Stop a running worker
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/fsmctl.ts \
  -c stop -q <instance-uuid>
```

For `create`/`resume` to actually run anything, a `fsmscheduler` and at least
one `fsmlet` with a matching FSM module both need to be running — see the
sections above. `fsmctl` itself has no signal handling to worry about: each
command runs once and the process exits (`0` on success, `1` on error).

---

## pgcron — one-shot pg_cron job (re)registration

`pgcron` idempotently (re)registers the `fsm_schedule_all_pending` `pg_cron`
job, which calls `fsm_core.schedule_all_pending()` on a timer to replace
`fsmscheduler`'s standing LISTEN/poll loop with an in-database periodic sweep
(see `docs/specs/spec-003-pgcron-fsm-scheduler.md` at the repo root).

This exists because `cron.schedule()` is a data-level side effect (a row insert
into `cron.job`) — migra's structural diff, used to generate the versioned pgxn
migration scripts under `packages/database-src/supabase/migrations/`, only picks
up DDL and can't capture it. Run this CLI once as a deploy-time step after
applying migrations, or whenever the schedule needs to change; it unschedules
any pre-existing job with the same name first, so re-running it is safe.

### Invocation

```bash
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/pgcron.ts [options]
```

### Options

| Flag                | Alias | Description                                                         |
| ------------------- | ----- | ------------------------------------------------------------------- |
| `--db-url <url>`    | `-d`  | PostgreSQL connection string (overrides `DATABASE_URL` from `.env`) |
| `--schedule <cron>` | `-s`  | `pg_cron` schedule expression (default: `"5 seconds"`)              |
| `--version`         | `-v`  | Print `@pgfsm/sync-worker`'s version and exit                       |
| `--help`            | `-h`  | Print help and exit                                                 |

### Example

```bash
# Minimal — reads DATABASE_URL from .env, uses the default 5s schedule
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/pgcron.ts

# Explicit connection + a coarser 30s schedule
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/pgcron.ts \
  -d postgresql://user:pass@localhost:5432/db \
  -s "30 seconds"
```

Like `fsmctl`, this is one-shot: it runs once and exits (`0` on success, `1` on
error). Neither `supabase db reset` (local dev) nor the applied
`supabase/migrations/` (production/pgxn) ever register the job on their own —
`cron.schedule()` is a data-level side effect, not something either path applies
automatically. Run this CLI once after migrations apply, in any environment, to
register or update the job.

---

## All flags (`fsmctl`)

| Flag            | Alias | Required by              | Description                                                    |
| --------------- | ----- | ------------------------ | -------------------------------------------------------------- |
| `--command`     | `-c`  | all                      | Command to run — `create` / `resume` / `send` / `stop`         |
| `--fsm-name`    | `-n`  | `create`                 | FSM definition name                                            |
| `--fsm-version` | `-V`  | `create`                 | FSM version number                                             |
| `--context`     |       | optional (`create`)      | Initial FSM context, JSON string                               |
| `--queue-name`  | `-q`  | `resume`, `send`, `stop` | FSM instance ID (UUID)                                         |
| `--event-type`  | `-e`  | `send`                   | Event type to send                                             |
| `--event-data`  |       | optional (`send`)        | Event payload, JSON string                                     |
| `--db-url`      | `-d`  | optional                 | Database connection URL (overrides `DATABASE_URL` from `.env`) |
| `--version`     | `-v`  |                          | Print `@pgfsm/sync-worker`'s version and exit                  |
| `--help`        | `-h`  |                          | Print help and exit                                            |

---

## `deno.json` tasks

```json
{
  "tasks": {
    "cli": "deno run --allow-all src/cli/fsmctl.ts",
    "dev": "deno run --allow-all --watch src/cli/fsmctl.ts",
    "fsmlet": "deno run --allow-all src/cli/fsmlet.ts",
    "fsmscheduler": "deno run --allow-all src/cli/fsmscheduler.ts",
    "pgcron": "deno run --allow-all src/cli/pgcron.ts",
    "check": "deno check src/index.ts"
  }
}
```

Run from `packages/fsm-sync-worker-ts/`, each task takes the CLI's own flags
after the task name, e.g. `deno task fsmlet -f <path>` or
`deno task cli -c create
-n creditCheck -V 1`. Equivalent direct invocations
from the repo root:

```bash
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/fsmctl.ts -c <command> [options]
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/fsmlet.ts -f <path>
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/fsmscheduler.ts
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/pgcron.ts
```

For the async-operation CLI tasks, see
[`fsm-async-worker-ts/docs/guides/CLI-USAGE.md`](../../../fsm-async-worker-ts/docs/guides/CLI-USAGE.md#denojson-tasks).

---

## FSM folder structure expected by `-f` / `--folder-path`

Both `fsmlet` (`--fsm-folder-path`) and the sibling package's
`async-operation-workerlet` (`--folder-path`) expect the same tree layout:

```
<fsm-folder>/
├── actions/
│   └── index.ts               # exports: { actionName: async (context, params, meta) => ... }
├── guards/
│   └── index.ts               # exports: { guardName: async (context, cond, meta) => boolean }
├── delays/
│   └── index.ts               # exports: { delayName: (context, event) => number }
└── actors/
    └── <actorName>/
        └── <actorName>.ts     # exports: { actorName: async (input) => output }
```

`actions`, `guards`, and `delays` are each a single `index.ts` module exporting
every name in that category. `actors` is one subfolder per actor — matching
exactly what `generate-async-logic` (`@pgfsm/compiler`) scaffolds — and
`startFSMAsyncOperationWorker`
(`fsm-async-worker-ts/src/asyncOperationWorkerlet/fsmasyncoperationworker.ts`)
loads each actor from its own file at runtime, using the module path and export
name already resolved during validation
(`ActorPluginValidationResult.fsmModulePath` / `.method`) — no aggregating
`actors/index.ts` is needed or read.

Any of these subdirectories may be absent if the FSM does not use that feature
type. The path is validated at startup — an invalid path exits with code 1
before any database connection is made.

---

## HTTP API reference

The API server (`apps/fsm-core-ts-hono-deno`) exposes the dispatch-queue routes
for `/fsm`. `verifiedModule` (actor/action folder) is resolved server-side from
`verifiedFsmModules` context using `fsm_name` + `fsm_version`.

| HTTP route                  | Model    | CLI equivalent     | Body                                                                                            |
| --------------------------- | -------- | ------------------ | ----------------------------------------------------------------------------------------------- |
| `GET /fsm`                  | —        | —                  | —                                                                                               |
| `POST /fsm`                 | dispatch | `fsmctl -c create` | `{ fsm_name, fsm_version, fsm_context? }` — creates instance + enqueues to `fsm_dispatch_queue` |
| `POST /fsm/stop`            | dispatch | `fsmctl -c stop`   | `{ queue }`                                                                                     |
| `POST /fsm/send`            | dispatch | `fsmctl -c send`   | `{ fsm_instance_id, event_data }`                                                               |
| `POST /fsm/dispatch`        | dispatch | `fsmctl -c create` | `{ fsm_name, fsm_version, fsm_context? }` — creates instance + enqueues to `fsm_dispatch_queue` |
| `POST /fsm/resume-dispatch` | dispatch | `fsmctl -c resume` | `{ queue }`                                                                                     |

`POST /fsm` (in `fsm.handlers.ts`) and `POST /fsm/dispatch` (in
`fsm.handlers.dispatch.ts`) both create an instance and enqueue it to
`fsm_dispatch_queue` — same dispatch-model creation, two route paths.
`POST /fsm/resume-dispatch` does the equivalent for resume. All three require a
running `fsmscheduler` + `fsmlet` to pick the work up. `POST /fsm/resume` and
`GET /fsm/currentActive`, the remaining in-process `/fsm` routes, were removed —
see ADR-002. The `/fsmpromise` routes (in-process, backed by v1's
`startFSMPromiseWorker`) were removed too — `async-operation-workerlet` (v1) and
`fsm-core-async-op-worker` (v2) are both driven only via their own CLIs, not
through the HTTP API.

---

## Exit codes

| Code | Meaning                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------------- |
| `0`  | Command completed (or long-running daemon exited) successfully                                                       |
| `1`  | Missing required arguments, invalid folder path, failed to acquire lock, failed to create instance, or runtime error |
