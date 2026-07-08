# fsm-core-worker-ts — CLI Usage Guide

This package provides two CLIs:

| CLI        | Entry point         | Role                                                                                                                   |
| ---------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **fsmlet** | `src/cli/fsmlet.ts` | Long-running node agent — registers itself with the scheduler, claims and drives FSM workers up to a concurrency limit |
| **fsmctl** | `src/cli/index.ts`  | One-shot worker commands — start/create individual FSM or promise workers directly                                     |

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
deno run --allow-all apps/fsm-core-worker-ts/src/cli/fsmlet.ts \
  -f <fsm-folder-path> [options]
```

### Options

| Flag                       | Alias | Required | Default                    | Description                                                                 |
| -------------------------- | ----- | -------- | -------------------------- | --------------------------------------------------------------------------- |
| `--fsm-folder-path <path>` | `-f`  | yes      | —                          | Path to the FSM folder tree (validated at startup before any DB connection) |
| `--db-url <url>`           | `-d`  | no       | `DATABASE_URL` from `.env` | PostgreSQL connection string                                                |
| `--max-concurrency <n>`    | `-m`  | no       | `8`                        | Max FSM instances driven concurrently on this node                          |
| `--fsmlet-id <id>`         | `-i`  | no       | random UUID                | Stable identity across restarts — also read from `FSMLET_ID` env var        |
| `--help`                   | `-h`  | —        | —                          | Print help and exit                                                         |

### Example

```bash
# Minimal — reads DATABASE_URL from .env
deno run --allow-all apps/fsm-core-worker-ts/src/cli/fsmlet.ts \
  -f apps/fsm-core-example/fsm

# Full options
deno run --allow-all apps/fsm-core-worker-ts/src/cli/fsmlet.ts \
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

## fsmctl — one-shot worker commands

`fsmctl` runs a single command against the database and exits (or stays running
for worker polling). Use this for manual testing or for starting individual
workers without the scheduler.

### Invocation

```bash
# Using deno task (recommended)
deno task cli -c <command> [options]

# Direct invocation
deno run --allow-all src/cli/index.ts -c <command> [options]

# Watch mode (for development)
deno task dev -c <command> [options]
```

---

## Commands

### `start-worker`

Start a polling worker on an existing PGMQ queue. Does **not** acquire a DB
advisory lock.

> **No HTTP equivalent** — the API always uses the lock variant. Use
> `start-worker-with-db-lock` or `POST /fsm/start` for production.

```bash
deno task cli \
  -c start-worker \
  -q <queue-name> \
  -n <fsm-name> \
  -v <fsm-version> \
  -f <abs-fsm-folder-path>
```

**Example — credit check FSM:**

```bash
deno task cli \
  -c start-worker \
  -q creditCheck_v01 \
  -n creditCheck \
  -v 1 \
  -f /abs/path/to/apps/fsm-core-example/fsm/creditCheck/v01
```

---

### `start-worker-with-db-lock`

Start a polling worker with a PostgreSQL advisory lock. Prevents duplicate
workers on the same queue. Exits with code 1 if another worker already holds the
lock.

**HTTP equivalent:** `POST /fsm/start`

```json
{ "queue": "creditCheck_v01" }
```

```bash
deno task cli \
  -c start-worker-with-db-lock \
  -q <queue-name> \
  -n <fsm-name> \
  -v <fsm-version> \
  -f <abs-fsm-folder-path> \
  [--validate-plugin]
```

**Example:**

```bash
deno task cli \
  -c start-worker-with-db-lock \
  -q creditCheck_v01 \
  -n creditCheck \
  -v 1 \
  -f /abs/path/to/apps/fsm-core-example/fsm/creditCheck/v01 \
  --validate-plugin
```

**`--validate-plugin`** — use `validateFsmPluginLoadFromFolder` instead of
direct `import()`. Useful when you want to validate that all required exports
(actions/guards/delays/actors) are present before starting.

---

### `start-promise-worker`

Start a promise (actor) worker on an existing PGMQ promise queue. Invokes the
named actor function for each queued message.

**HTTP equivalent:** `POST /fsmpromise/start`

```json
{
  "promise_name": "checkBureau_v01",
  "promise_type": "checkBureau",
  "promise_version": "1",
  "fsm_name": "creditCheck",
  "fsm_version": "1"
}
```

> **Note:** `-n` must be the **parent FSM name** (e.g. `creditCheck`), not the
> actor name. The actor type is specified separately with `-t`.

```bash
deno task cli \
  -c start-promise-worker \
  -q <queue-name> \
  -t <promise-type> \
  -n <parent-fsm-name> \
  -v <fsm-version> \
  -f <abs-fsm-folder-path>
```

**Example — credit bureau check actor:**

```bash
deno task cli \
  -c start-promise-worker \
  -q checkBureau_v01 \
  -t checkBureau \
  -n creditCheck \
  -v 1 \
  -f /abs/path/to/apps/fsm-core-example/fsm/creditCheck/v01
```

**`-t / --promise-type`** — the actor/promise type name. Must match an export in
the `actors/` folder of the FSM definition.

---

### `create-and-start-worker`

Create a new FSM instance (and its PGMQ queue) then immediately start a worker
with a DB advisory lock. This is the most common command for spinning up a fresh
workflow.

**HTTP equivalent:** `POST /fsm`

```json
{
  "fsm_name": "creditCheck",
  "fsm_version": "1",
  "fsm_context": {}
}
```

Returns `{ "data": { "fsm_instance_id": "<uuid>", ... } }`.

```bash
deno task cli \
  -c create-and-start-worker \
  -n <fsm-name> \
  -v <fsm-version> \
  -f <abs-fsm-folder-path> \
  [--validate-plugin]
```

**Example:**

```bash
deno task cli \
  -c create-and-start-worker \
  -n creditCheck \
  -v 1 \
  -f /abs/path/to/apps/fsm-core-example/fsm/creditCheck/v01
```

The created FSM instance ID is printed to stdout. The worker then runs
indefinitely, polling its queue.

> **Note:** Initial FSM context defaults to `{}`. To pass custom context via
> HTTP, include `fsm_context` in the request body.

---

### `create-and-start-promise-worker`

Create a new PGMQ queue and start a promise worker on it.

**HTTP equivalent:** `POST /fsmpromise/create-and-start`

```json
{
  "queue_name": "checkBureau_v01",
  "fsm_name": "creditCheck",
  "promise_type": "checkBureau",
  "fsm_version": "1"
}
```

> **Note:** `-n` must be the **parent FSM name** (e.g. `creditCheck`), not the
> actor name.

```bash
deno task cli \
  -c create-and-start-promise-worker \
  -q <queue-name> \
  -t <promise-type> \
  -n <parent-fsm-name> \
  -v <fsm-version> \
  -f <abs-fsm-folder-path>
```

**Example:**

```bash
deno task cli \
  -c create-and-start-promise-worker \
  -q checkBureau_v01 \
  -t checkBureau \
  -n creditCheck \
  -v 1 \
  -f /abs/path/to/apps/fsm-core-example/fsm/creditCheck/v01
```

---

## All flags

| Flag                | Alias | Required by                                               | Description                                                    |
| ------------------- | ----- | --------------------------------------------------------- | -------------------------------------------------------------- |
| `--command`         | `-c`  | all                                                       | Command to run (see above)                                     |
| `--queue-name`      | `-q`  | all except `create-and-start-worker`                      | PGMQ queue name                                                |
| `--fsm-name`        | `-n`  | all                                                       | FSM definition name                                            |
| `--fsm-version`     | `-v`  | all                                                       | FSM version number                                             |
| `--fsm-folder-path` | `-f`  | all                                                       | Absolute path to FSM folder (validated at startup)             |
| `--promise-type`    | `-t`  | `start-promise-worker`, `create-and-start-promise-worker` | Actor/promise type name                                        |
| `--db-url`          | `-d`  | optional                                                  | Database connection URL (overrides `DATABASE_URL` from `.env`) |
| `--validate-plugin` |       | optional                                                  | Use plugin validator instead of direct imports                 |
| `--help`            | `-h`  |                                                           | Print help and exit                                            |

---

## Graceful shutdown

All commands support graceful and force shutdown via keyboard signals:

| Signal                        | Behavior                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Ctrl+C once** (SIGINT)      | Graceful stop — signals the worker loop to exit after the current iteration, then releases the DB advisory lock |
| **Ctrl+C twice** (SIGINT × 2) | Force exit — `Deno.exit(0)` immediately (DB lock released by session-end cleanup)                               |
| **SIGTERM**                   | Same as first Ctrl+C — graceful stop                                                                            |

The worker loop checks the abort signal on each iteration
(`while (!signal?.aborted)`), so graceful stop completes within one poll cycle
(at most ~30 seconds for the PGMQ visibility timeout, typically 1 second when
the queue is idle).

---

## `deno.json` tasks

```json
{
  "tasks": {
    "dev": "deno run --allow-all --watch src/cli/index.ts",
    "cli": "deno run --allow-all src/cli/index.ts",
    "daemon": "deno run --allow-all src/cli/daemon.ts",
    "ctl": "deno run --allow-all src/cli/ctl.ts",
    "check": "deno check src/index.ts"
  }
}
```

| Task              | Equivalent                                      | Notes                                           |
| ----------------- | ----------------------------------------------- | ----------------------------------------------- |
| `deno task cli`   | `deno run --allow-all src/cli/index.ts`         | One-shot fsmctl command                         |
| `deno task dev`   | `deno run --allow-all --watch src/cli/index.ts` | fsmctl with `--watch` (restarts on file change) |
| `deno task check` | `deno check src/index.ts`                       | Type-check all exports without running          |

> **fsmlet has no dedicated task yet** — invoke it directly:
> `deno run --allow-all apps/fsm-core-worker-ts/src/cli/fsmlet.ts -f <path>`

---

## FSM folder structure expected by `--fsm-folder-path`

```
<fsm-folder>/
├── actions/
│   └── index.ts      # exports: { actionName: async (context, params, meta) => ... }
├── guards/
│   └── index.ts      # exports: { guardName: async (context, cond, meta) => boolean }
├── delays/
│   └── index.ts      # exports: { delayName: (context, event) => number }
└── actors/
    └── index.ts      # exports: { actorName: async (input) => output }
```

Any of these subdirectories may be absent if the FSM does not use that feature
type. The path is validated at startup — an invalid path exits with code 1
before any database connection is made.

---

## HTTP API reference

The API server (`apps/fsm-core-ts-hono-deno`) exposes HTTP equivalents for most
commands. `verifiedModule` (actor/action folder) is resolved server-side from
`verifiedFsmModules` context using `fsm_name` + `fsm_version`.

| HTTP route                          | CLI equivalent                    | Body                                                                         |
| ----------------------------------- | --------------------------------- | ---------------------------------------------------------------------------- |
| `GET /fsm`                          | —                                 | —                                                                            |
| `POST /fsm`                         | `create-and-start-worker`         | `{ fsm_name, fsm_version, fsm_context? }` — creates instance + starts worker |
| `POST /fsm/start`                   | `start-worker-with-db-lock`       | `{ queue }`                                                                  |
| `POST /fsm/stop`                    | Ctrl+C (graceful)                 | `{ queue }`                                                                  |
| `GET /fsm/currentActive`            | —                                 | —                                                                            |
| `POST /fsm/send`                    | —                                 | `{ fsm_instance_id, event_data }`                                            |
| `GET /fsmpromise`                   | —                                 | —                                                                            |
| `POST /fsmpromise/start`            | `start-promise-worker`            | `{ promise_name, promise_type, promise_version, fsm_name, fsm_version }`     |
| `POST /fsmpromise/stop`             | Ctrl+C (graceful)                 | `{ queue }`                                                                  |
| `POST /fsmpromise/create-and-start` | `create-and-start-promise-worker` | `{ queue_name, fsm_name, promise_type, fsm_version }`                        |

---

## Exit codes

| Code | Meaning                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Worker started (or command completed or gracefully stopped) successfully                                                     |
| `1`  | Missing required arguments, invalid `--fsm-folder-path`, failed to acquire lock, failed to create instance, or runtime error |
