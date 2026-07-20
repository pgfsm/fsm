# fsm-core-worker-ts — CLI Usage Guide

This package provides six CLIs:

| CLI                           | Entry point                            | Role                                                                                                                                                                         |
| ----------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **fsmlet**                    | `src/cli/fsmlet.ts`                    | Long-running node agent (kubelet equivalent) — registers itself, claims and drives FSM workers up to a concurrency limit                                                     |
| **async-operation-workerlet** | `src/cli/async-operation-workerlet.ts` | Long-running async-op node agent (kubelet equivalent) — validates actors, registers in `async_operation_workerlet`, claims and drives promise workers via LISTEN + heartbeat |
| **fsmscheduler**              | `src/cli/fsmscheduler.ts`              | Control-plane routing process (kube-scheduler equivalent) for `fsmlet` node agents. Run once per cluster, not on worker nodes                                                |
| **async-operation-scheduler** | `src/cli/async-operation-scheduler.ts` | Control-plane routing process (kube-scheduler equivalent) for `async-operation-workerlet` node agents. Run once per cluster, not on worker nodes                             |
| **fsmctl**                    | `src/cli/fsmctl.ts`                    | One-shot control CLI (kubectl equivalent) — create/resume/send/stop against the dispatch-queue model, then exits                                                             |
| **async-operation-ctl**       | `src/cli/async-operation-ctl.ts`       | One-shot control CLI (kubectl equivalent) — list-instances/list-meta/dispatch against the async-operation dispatch tables, then exits                                        |

> **Also present, not covered here:**
> `src/deprecated-inprocess-approach/deprecated_inprocess_worker.ts` — the
> legacy pre-scheduler CLI (`resume-worker`, `start-promise-worker`,
> `create-and-start-worker`, `create-and-start-promise-worker`, `stop-worker`).
> Superseded by the `fsmlet` / `fsmscheduler` dispatch model above; still
> present in the tree but not the recommended path for new work.

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

## async-operation-workerlet — async-op node agent

`async-operation-workerlet` is the long-running scheduler-aware daemon for async
operations (analogous to `fsmlet` for FSMs). It scans an FSM folder for async
actors, loads them into `async_operation_meta`, registers itself in
`async_operation_workerlet`, then listens for work routed by the scheduler via
`pg_notify`. It drives one long-running promise-worker per actor queue, bounded
by `--max-concurrency`.

### Invocation

```bash
# From repo root
deno run --allow-all apps/fsm-core-worker-ts/src/cli/async-operation-workerlet.ts \
  -f <folder-path> -l <langs> [options]
```

### Options

| Flag                          | Alias | Required | Default                    | Description                                                                        |
| ----------------------------- | ----- | -------- | -------------------------- | ---------------------------------------------------------------------------------- |
| `--folder-path <path>`        | `-f`  | yes      | —                          | Path to the FSM folder tree to scan for async actors (validated before DB connect) |
| `--runtime-languages <langs>` | `-l`  | yes      | —                          | Comma-separated languages to validate: `typescript`, `python`, `go`, `rust`        |
| `--db-url <url>`              | `-d`  | no       | `DATABASE_URL` from `.env` | PostgreSQL connection string                                                       |
| `--max-concurrency <n>`       | `-m`  | no       | `8`                        | Max concurrent queue-workers on this node                                          |
| `--workerlet-id <id>`         | `-i`  | no       | random UUID                | Stable identity across restarts — also read from `ASYNC_OP_WORKERLET_ID` env var   |
| `--workflow-type <type>`      | `-t`  | no       | `promise`                  | `promise` (actors co-located with an FSM) or `sharedPromise` (shared actors)       |
| `--help`                      | `-h`  | —        | —                          | Print help and exit                                                                |

> **Why `--runtime-languages` is required:** the validator scans per-language
> subdirectories (`typescript/`, `python/`, etc.) and only checks the languages
> you declare. Omitting it means zero actors are validated and the workerlet
> throws immediately.

### Example

```bash
# Minimal — TypeScript actors only, reads DATABASE_URL from .env
deno run --allow-all apps/fsm-core-worker-ts/src/cli/async-operation-workerlet.ts \
  --folder-path apps/fsm-core-example/fsm \
  --runtime-languages typescript \
  --workflow-type promise

# Multiple languages
deno run --allow-all apps/fsm-core-worker-ts/src/cli/async-operation-workerlet.ts \
  --folder-path apps/fsm-core-example/fsm \
  --runtime-languages typescript,python \
  --workflow-type promise

# Full options
deno run --allow-all apps/fsm-core-worker-ts/src/cli/async-operation-workerlet.ts \
  --folder-path apps/fsm-core-example/fsm \
  --runtime-languages typescript \
  --db-url postgresql://user:pass@localhost:5432/db \
  --workflow-type promise \
  --max-concurrency 4 \
  --workerlet-id my-async-node-01
```

### `--folder-path` structure expected

`validateAsyncOperationFromFoldersV2` scans for actors inside the folder tree in
the pattern `<fsmName>/<version>/<lang>/actors/<actorName>/`. Pass the root that
contains FSM subdirectories, the same path you would give `fsmlet`:

```
<folder-path>/
└── creditCheck/
    └── v01/
        └── typescript/
            └── actors/
                └── checkBureau.ts
```

### Startup sequence

1. **Validate** — runs `validateAsyncOperationFromFoldersV2`; only actors that
   pass (`isVerified = true`) proceed.
2. **Load** — upserts each verified actor into `async_operation_meta` via
   `load_async_operation_meta_v2`.
3. **Register** — upserts this node into `async_operation_workerlet` with the
   full supported-op list and `max_pid_number`.
4. **LISTEN** — opens a dedicated connection and subscribes to
   `async_op_workerlet_work_<id>`.
5. **Claim & dispatch** — on each notification, calls
   `claim_scheduled_for_async_operation_workerlet()` atomically, then starts a
   long-running promise-worker for that actor queue (one worker per unique
   queue, bounded by semaphore).
6. **Heartbeat** — sends a heartbeat every 5 s so the scheduler can score this
   node.
7. **Fallback poll** — polls every 30 s to catch any `pg_notify` missed after a
   LISTEN connection drop.

### Graceful shutdown

| Signal                             | Behaviour                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Ctrl+C once** (SIGINT / SIGTERM) | Aborts all active queue-workers, drains until they exit, deregisters from `async_operation_workerlet`, closes pool |
| **Ctrl+C twice**                   | Force-exit (`Deno.exit(0)`) — DB registration cleaned up on session-end                                            |

### Environment variables

| Variable                | Description                                                         |
| ----------------------- | ------------------------------------------------------------------- |
| `DATABASE_URL`          | Fallback DB connection string (used when `--db-url` is not passed)  |
| `ASYNC_OP_WORKERLET_ID` | Fallback stable identity (used when `--workerlet-id` is not passed) |

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
deno run --allow-all apps/fsm-core-worker-ts/src/cli/fsmscheduler.ts [options]
```

### Options

| Flag                    | Alias | Required | Default                    | Description                                                    |
| ----------------------- | ----- | -------- | -------------------------- | -------------------------------------------------------------- |
| `--db-url <url>`        | `-d`  | no       | `DATABASE_URL` from `.env` | PostgreSQL connection string (required — exits if unset)       |
| `--poll-interval <ms>`  | `-p`  | no       | `30000`                    | Fallback poll interval in milliseconds                         |
| `--stale-threshold <s>` | `-s`  | no       | `30`                       | Seconds before a `fsmlet` with no heartbeat is treated as dead |
| `--help`                | `-h`  | —        | —                          | Print help and exit                                            |

### Example

```bash
deno run --allow-all apps/fsm-core-worker-ts/src/cli/fsmscheduler.ts \
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

## async-operation-scheduler — control-plane routing process

`async-operation-scheduler` is the control-plane routing process (kube-scheduler
equivalent) for `async-operation-workerlet` node agents. Structurally identical
to `fsmscheduler`, routing a different dispatch table to a different node-agent
type. Run it once per cluster, alongside the API server, **not** on a machine
also running `async-operation-workerlet`.

### Invocation

```bash
# From repo root
deno run --allow-all apps/fsm-core-worker-ts/src/cli/async-operation-scheduler.ts [options]
```

### Options

| Flag                    | Alias | Required | Default                    | Description                                                     |
| ----------------------- | ----- | -------- | -------------------------- | --------------------------------------------------------------- |
| `--db-url <url>`        | `-d`  | no       | `DATABASE_URL` from `.env` | PostgreSQL connection string (required — exits if unset)        |
| `--poll-interval <ms>`  | `-p`  | no       | `30000`                    | Fallback poll interval in milliseconds                          |
| `--stale-threshold <s>` | `-s`  | no       | `30`                       | Seconds before a workerlet with no heartbeat is treated as dead |
| `--help`                | `-h`  | —        | —                          | Print help and exit                                             |

### Example

```bash
deno run --allow-all apps/fsm-core-worker-ts/src/cli/async-operation-scheduler.ts \
  -d postgresql://user:pass@localhost:5432/db \
  -p 30000 \
  -s 30
```

### Behavior

1. **LISTEN** — opens a dedicated connection and subscribes to
   `async_operation_scheduler_work`.
2. **Scheduling cycle** — on each notification, loops
   `fsm_core.async_operation_schedule_next_pending()` until the queue is empty
   or no `async-operation-workerlet` has capacity. Each call atomically claims a
   pending entry from `async_operation_instance_and_async_operation_workerlet`,
   filters/scores active workerlets, assigns the winner, and `pg_notify`s it.
3. **Initial cycle** — runs one scheduling cycle immediately on startup.
4. **Fallback poll** — every 30 s by default (`--poll-interval`), catches any
   `pg_notify` missed after a `LISTEN` connection drop.

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
deno run --allow-all apps/fsm-core-worker-ts/src/cli/fsmctl.ts -c <command> [options]
```

> **`deno task cli` / `deno task dev` are currently broken.** `deno.json` points
> them at `src/cli/index.ts`, which no longer exists — it was renamed to
> `src/deprecated-inprocess-approach/deprecated_inprocess_worker.ts` when
> `fsmctl` was introduced. Invoke `fsmctl.ts` directly as shown above until
> `deno.json` is updated (see [`deno.json` tasks](#denojson-tasks)).

### Commands

| Command  | Required flags                         | Description                                                                               |
| -------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `create` | `-n, --fsm-name`, `-v, --fsm-version`  | Create a new FSM instance and enqueue it to `fsm_dispatch_queue` for the `fsmscheduler`   |
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
| `--fsm-version <ver>` | `-v`  | FSM version (required for `create`)                                              |
| `--context <json>`    |       | Initial FSM context as a JSON string (optional, `create` only; defaults to `{}`) |
| `--queue-name <id>`   | `-q`  | FSM instance ID (required for `resume`, `send`, `stop`)                          |
| `--event-type <type>` | `-e`  | Event type to send (required for `send`)                                         |
| `--event-data <json>` |       | Event payload as a JSON string (optional, `send` only)                           |
| `--db-url <url>`      | `-d`  | PostgreSQL connection string (overrides `DATABASE_URL` from `.env`)              |
| `--help`              | `-h`  | Print help and exit                                                              |

### Examples

```bash
# Create a new FSM instance (prints the instance UUID to stdout)
deno run --allow-all apps/fsm-core-worker-ts/src/cli/fsmctl.ts \
  -c create -n creditCheck -v 1

# ...with initial context
deno run --allow-all apps/fsm-core-worker-ts/src/cli/fsmctl.ts \
  -c create -n creditCheck -v 1 --context '{"userId":"abc"}'

# Resume an existing instance
deno run --allow-all apps/fsm-core-worker-ts/src/cli/fsmctl.ts \
  -c resume -q <instance-uuid>

# Send an event
deno run --allow-all apps/fsm-core-worker-ts/src/cli/fsmctl.ts \
  -c send -q <instance-uuid> -e APPROVE

# ...with an event payload
deno run --allow-all apps/fsm-core-worker-ts/src/cli/fsmctl.ts \
  -c send -q <instance-uuid> -e APPROVE --event-data '{"reason":"ok"}'

# Stop a running worker
deno run --allow-all apps/fsm-core-worker-ts/src/cli/fsmctl.ts \
  -c stop -q <instance-uuid>
```

For `create`/`resume` to actually run anything, a `fsmscheduler` and at least
one `fsmlet` with a matching FSM module both need to be running — see the
sections above. `fsmctl` itself has no signal handling to worry about: each
command runs once and the process exits (`0` on success, `1` on error).

---

## All flags (`fsmctl`)

| Flag            | Alias | Required by              | Description                                                    |
| --------------- | ----- | ------------------------ | -------------------------------------------------------------- |
| `--command`     | `-c`  | all                      | Command to run — `create` / `resume` / `send` / `stop`         |
| `--fsm-name`    | `-n`  | `create`                 | FSM definition name                                            |
| `--fsm-version` | `-v`  | `create`                 | FSM version number                                             |
| `--context`     |       | optional (`create`)      | Initial FSM context, JSON string                               |
| `--queue-name`  | `-q`  | `resume`, `send`, `stop` | FSM instance ID (UUID)                                         |
| `--event-type`  | `-e`  | `send`                   | Event type to send                                             |
| `--event-data`  |       | optional (`send`)        | Event payload, JSON string                                     |
| `--db-url`      | `-d`  | optional                 | Database connection URL (overrides `DATABASE_URL` from `.env`) |
| `--help`        | `-h`  |                          | Print help and exit                                            |

---

## async-operation-ctl — one-shot control CLI

`async-operation-ctl` is the one-shot control CLI (kubectl equivalent) for the
async-operation dispatch tables. Like `fsmctl`, it issues a single command and
exits immediately.

### Invocation

```bash
deno run --allow-all apps/fsm-core-worker-ts/src/cli/async-operation-ctl.ts -c <command> [options]
```

### Commands

| Command          | Required flags                                                                                             | Description                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `list-instances` | none                                                                                                       | Lists every row in `async_operation_instance_and_async_operation_workerlet` (`created_at DESC`)                                               |
| `list-meta`      | none                                                                                                       | Lists every row in `async_operation_meta` (`updated_at DESC`)                                                                                 |
| `dispatch`       | `-n, --name`, `-v, --version`, `-t, --type`, `--parent-fsm-name`, `--parent-fsm-version`, `-l, --language` | Enqueues an async-operation instance to `async_operation_instance_and_async_operation_workerlet` and notifies the `async-operation-scheduler` |

`dispatch` calls
`createAsyncOperationInstanceAndNotifyAsyncOperationSchedulerWork`
(`fsm_core.create_async_operation_instance_and_notify_async_operation_scheduler_work`
under the hood — mirrors `create_fsm_instance_from_name_v2`'s internal
`enqueue_fsm_dispatch_v2` call on the FSM side), but nothing else in the
codebase calls it yet — the FSM macrostep code that fires `invoke` actions does
not enqueue through this table (see the compiler/worker integration notes
elsewhere in this repo). Use `dispatch` to manually enqueue an async-operation
instance for testing or ops purposes.

### Options

| Flag                         | Alias | Description                                                                       |
| ---------------------------- | ----- | --------------------------------------------------------------------------------- |
| `--command <command>`        | `-c`  | Command to run — `list-instances` / `list-meta` / `dispatch` (required)           |
| `--instance-id <uuid>`       |       | Async-operation instance ID (`dispatch` only; default: random UUID)               |
| `--name <name>`              | `-n`  | Async-operation name (required for `dispatch`)                                    |
| `--version <version>`        | `-v`  | Async-operation version (required for `dispatch`)                                 |
| `--type <type>`              | `-t`  | Async-operation type, e.g. `promise` \| `sharedPromise` (required for `dispatch`) |
| `--parent-fsm-name <name>`   |       | Parent FSM name (required for `dispatch`)                                         |
| `--parent-fsm-version <ver>` |       | Parent FSM version (required for `dispatch`)                                      |
| `--language <lang>`          | `-l`  | Async-operation language, e.g. `typescript` (required for `dispatch`)             |
| `--db-url <url>`             | `-d`  | PostgreSQL connection string (overrides `DATABASE_URL` from `.env`)               |
| `--help`                     | `-h`  | Print help and exit                                                               |

### Examples

```bash
# List pending/scheduled async-operation instances
deno run --allow-all apps/fsm-core-worker-ts/src/cli/async-operation-ctl.ts \
  -c list-instances

# List validated async-operation metadata
deno run --allow-all apps/fsm-core-worker-ts/src/cli/async-operation-ctl.ts \
  -c list-meta

# Manually enqueue an async-operation instance
deno run --allow-all apps/fsm-core-worker-ts/src/cli/async-operation-ctl.ts \
  -c dispatch \
  -n checkBureau -v 1 -t promise \
  --parent-fsm-name creditCheck --parent-fsm-version 1 \
  -l typescript
```

For `dispatch` to actually run anything, an `async-operation-scheduler` and at
least one `async-operation-workerlet` with matching supported ops both need to
be running — see the sections above. Like `fsmctl`, each command runs once and
the process exits (`0` on success, `1` on error).

---

## `deno.json` tasks

```json
{
  "tasks": {
    "cli": "deno run --allow-all src/cli/fsmctl.ts",
    "dev": "deno run --allow-all --watch src/cli/fsmctl.ts",
    "async-operation-ctl": "deno run --allow-all src/cli/async-operation-ctl.ts",
    "fsmlet": "deno run --allow-all src/cli/fsmlet.ts",
    "async-operation-workerlet": "deno run --allow-all src/cli/async-operation-workerlet.ts",
    "fsmscheduler": "deno run --allow-all src/cli/fsmscheduler.ts",
    "async-operation-scheduler": "deno run --allow-all src/cli/async-operation-scheduler.ts",
    "check": "deno check src/index.ts"
  }
}
```

Run from `apps/fsm-core-worker-ts/`, each task takes the CLI's own flags after
the task name, e.g. `deno task fsmlet -f <path>` or
`deno task cli -c create
-n creditCheck -v 1`. Equivalent direct invocations
from the repo root:

```bash
deno run --allow-all apps/fsm-core-worker-ts/src/cli/fsmctl.ts -c <command> [options]
deno run --allow-all apps/fsm-core-worker-ts/src/cli/async-operation-ctl.ts -c <command> [options]
deno run --allow-all apps/fsm-core-worker-ts/src/cli/fsmlet.ts -f <path>
deno run --allow-all apps/fsm-core-worker-ts/src/cli/async-operation-workerlet.ts -f <path> -l typescript -t promise
deno run --allow-all apps/fsm-core-worker-ts/src/cli/fsmscheduler.ts
deno run --allow-all apps/fsm-core-worker-ts/src/cli/async-operation-scheduler.ts
```

---

## FSM folder structure expected by `-f` / `--folder-path`

Both `fsmlet` (`--fsm-folder-path`) and `async-operation-workerlet`
(`--folder-path`) expect the same tree layout:

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
`startFSMPromiseWorker` (`asyncOperationWorkerlet/fsmpromiseworker.ts`) loads
each actor from its own file at runtime, using the module path and export name
already resolved during validation (`ActorPluginValidationResult.fsmModulePath`
/ `.method`) — no aggregating `actors/index.ts` is needed or read.

Any of these subdirectories may be absent if the FSM does not use that feature
type. The path is validated at startup — an invalid path exits with code 1
before any database connection is made.

---

## HTTP API reference

The API server (`apps/fsm-core-ts-hono-deno`) exposes both the legacy in-process
routes and the newer dispatch-queue routes side by side. `verifiedModule`
(actor/action folder) is resolved server-side from `verifiedFsmModules` context
using `fsm_name` + `fsm_version`.

| HTTP route                          | Model      | CLI equivalent                                                      | Body                                                                                            |
| ----------------------------------- | ---------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /fsm`                          | —          | —                                                                   | —                                                                                               |
| `POST /fsm`                         | in-process | `deprecated_inprocess_worker.ts -c create-and-start-worker`         | `{ fsm_name, fsm_version, fsm_context? }` — creates instance + starts worker directly           |
| `POST /fsm/resume`                  | in-process | `deprecated_inprocess_worker.ts -c resume-worker`                   | `{ queue }`                                                                                     |
| `POST /fsm/stop`                    | either     | `fsmctl -c stop`                                                    | `{ queue }`                                                                                     |
| `GET /fsm/currentActive`            | in-process | —                                                                   | —                                                                                               |
| `POST /fsm/send`                    | either     | `fsmctl -c send`                                                    | `{ fsm_instance_id, event_data }`                                                               |
| `POST /fsm/dispatch`                | dispatch   | `fsmctl -c create`                                                  | `{ fsm_name, fsm_version, fsm_context? }` — creates instance + enqueues to `fsm_dispatch_queue` |
| `POST /fsm/resume-dispatch`         | dispatch   | `fsmctl -c resume`                                                  | `{ queue }`                                                                                     |
| `GET /fsmpromise`                   | in-process | —                                                                   | —                                                                                               |
| `POST /fsmpromise/resume`           | in-process | `deprecated_inprocess_worker.ts -c start-promise-worker`            | `{ promise_name, promise_type, promise_version, fsm_name, fsm_version }`                        |
| `POST /fsmpromise/stop`             | in-process | Ctrl+C (graceful) / `fsmctl -c stop`                                | `{ queue }`                                                                                     |
| `POST /fsmpromise/create-and-start` | in-process | `deprecated_inprocess_worker.ts -c create-and-start-promise-worker` | `{ queue_name, fsm_name, promise_type, fsm_version }`                                           |

`POST /fsm` and `POST /fsm/resume` start (or resume) a worker directly inside
the API server process — the same in-process model as
`deprecated_inprocess_worker.ts`. `POST /fsm/dispatch` and
`POST /fsm/resume-dispatch` instead enqueue to `fsm_dispatch_queue`, the same
path `fsmctl create`/`resume` use, requiring a running `fsmscheduler` + `fsmlet`
to pick the work up. `fsmpromise` has no dispatch-model route yet —
`async-operation-workerlet` is driven only via its own CLI, not through the HTTP
API.

---

## Exit codes

| Code | Meaning                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------------- |
| `0`  | Command completed (or long-running daemon exited) successfully                                                       |
| `1`  | Missing required arguments, invalid folder path, failed to acquire lock, failed to create instance, or runtime error |
