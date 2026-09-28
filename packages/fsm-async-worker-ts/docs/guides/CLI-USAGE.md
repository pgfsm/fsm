# fsm-async-worker-ts — CLI Usage Guide

This package provides three CLIs:

| CLI                           | Entry point                            | Role                                                                                                                                                                                 |
| ----------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **async-operation-workerlet** | `src/cli/async-operation-workerlet.ts` | Long-running async-op node agent (kubelet equivalent) — validates actors, registers in `async_operation_workerlet`, claims and drives async-operation workers via LISTEN + heartbeat |
| **async-operation-scheduler** | `src/cli/async-operation-scheduler.ts` | Control-plane routing process (kube-scheduler equivalent) for `async-operation-workerlet` node agents. Run once per cluster, not on worker nodes                                     |
| **async-operation-ctl**       | `src/cli/async-operation-ctl.ts`       | One-shot control CLI (kubectl equivalent) — list-instances/list-meta/dispatch against the async-operation dispatch tables, then exits                                                |

For the FSM-side ops CLI (`pgfsmctl`: pg_cron scheduler, instance control,
fallback scheduler), see
[`fsm-ctl-ts/docs/guides/CLI-USAGE.md`](../../../fsm-ctl-ts/docs/guides/CLI-USAGE.md).

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

## async-operation-workerlet — async-op node agent

`async-operation-workerlet` is the long-running scheduler-aware daemon for async
operations (analogous to `fsmlet` for FSMs). It scans an FSM folder for async
actors, loads them into `async_operation_meta`, registers itself in
`async_operation_workerlet`, then listens for work routed by the scheduler via
`pg_notify`. It drives one long-running async-operation worker per actor queue,
bounded by `--max-concurrency`.

### Invocation

```bash
# From repo root
deno run --allow-all packages/fsm-async-worker-ts/src/cli/async-operation-workerlet.ts \
  -f <folder-path> -l <langs> [options]
```

### Options

| Flag                          | Alias | Required | Default                    | Description                                                                                        |
| ----------------------------- | ----- | -------- | -------------------------- | -------------------------------------------------------------------------------------------------- |
| `--folder-path <path>`        | `-f`  | yes      | —                          | Path to the FSM folder tree to scan for async actors (validated before DB connect)                 |
| `--runtime-languages <langs>` | `-l`  | yes      | —                          | Comma-separated languages to validate: `typescript`, `python`, `go`, `rust`                        |
| `--db-url <url>`              | `-d`  | no       | `DATABASE_URL` from `.env` | PostgreSQL connection string                                                                       |
| `--max-concurrency <n>`       | `-m`  | no       | `8`                        | Max concurrent queue-workers on this node                                                          |
| `--workerlet-id <id>`         | `-i`  | no       | random UUID                | Stable identity across restarts — also read from `ASYNC_OP_WORKERLET_ID` env var                   |
| `--workflow-type <type>`      | `-t`  | no       | `internalAsyncOperation`   | `internalAsyncOperation` (actors co-located with an FSM) or `sharedAsyncOperation` (shared actors) |
| `--help`                      | `-h`  | —        | —                          | Print help and exit                                                                                |

> **Why `--runtime-languages` is required:** the validator scans per-language
> subdirectories (`typescript/`, `python/`, etc.) and only checks the languages
> you declare. Omitting it means zero actors are validated and the workerlet
> throws immediately.

### Example

```bash
# Minimal — TypeScript actors only, reads DATABASE_URL from .env
deno run --allow-all packages/fsm-async-worker-ts/src/cli/async-operation-workerlet.ts \
  --folder-path apps/fsm-core-example/fsm \
  --runtime-languages typescript \
  --workflow-type internalAsyncOperation

# Multiple languages
deno run --allow-all packages/fsm-async-worker-ts/src/cli/async-operation-workerlet.ts \
  --folder-path apps/fsm-core-example/fsm \
  --runtime-languages typescript,python \
  --workflow-type internalAsyncOperation

# Full options
deno run --allow-all packages/fsm-async-worker-ts/src/cli/async-operation-workerlet.ts \
  --folder-path apps/fsm-core-example/fsm \
  --runtime-languages typescript \
  --db-url postgresql://user:pass@localhost:5432/db \
  --workflow-type internalAsyncOperation \
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
   long-running async-operation worker for that actor queue (one worker per
   unique queue, bounded by semaphore).
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

## async-operation-scheduler — control-plane routing process

`async-operation-scheduler` is the control-plane routing process (kube-scheduler
equivalent) for `async-operation-workerlet` node agents. Structurally identical
to `fsmscheduler`, routing a different dispatch table to a different node-agent
type. Run it once per cluster, alongside the API server, **not** on a machine
also running `async-operation-workerlet`.

### Invocation

```bash
# From repo root
deno run --allow-all packages/fsm-async-worker-ts/src/cli/async-operation-scheduler.ts [options]
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
deno run --allow-all packages/fsm-async-worker-ts/src/cli/async-operation-scheduler.ts \
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

## async-operation-ctl — one-shot control CLI

`async-operation-ctl` is the one-shot control CLI (kubectl equivalent) for the
async-operation dispatch tables. Like `fsmctl`, it issues a single command and
exits immediately.

### Invocation

```bash
deno run --allow-all packages/fsm-async-worker-ts/src/cli/async-operation-ctl.ts -c <command> [options]
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

| Flag                         | Alias | Description                                                                                             |
| ---------------------------- | ----- | ------------------------------------------------------------------------------------------------------- |
| `--command <command>`        | `-c`  | Command to run — `list-instances` / `list-meta` / `dispatch` (required)                                 |
| `--instance-id <uuid>`       |       | Async-operation instance ID (`dispatch` only; default: random UUID)                                     |
| `--name <name>`              | `-n`  | Async-operation name (required for `dispatch`)                                                          |
| `--version <version>`        | `-v`  | Async-operation version (required for `dispatch`)                                                       |
| `--type <type>`              | `-t`  | Async-operation type, e.g. `internalAsyncOperation` \| `sharedAsyncOperation` (required for `dispatch`) |
| `--parent-fsm-name <name>`   |       | Parent FSM name (required for `dispatch`)                                                               |
| `--parent-fsm-version <ver>` |       | Parent FSM version (required for `dispatch`)                                                            |
| `--language <lang>`          | `-l`  | Async-operation language, e.g. `typescript` (required for `dispatch`)                                   |
| `--db-url <url>`             | `-d`  | PostgreSQL connection string (overrides `DATABASE_URL` from `.env`)                                     |
| `--help`                     | `-h`  | Print help and exit                                                                                     |

### Examples

```bash
# List pending/scheduled async-operation instances
deno run --allow-all packages/fsm-async-worker-ts/src/cli/async-operation-ctl.ts \
  -c list-instances

# List validated async-operation metadata
deno run --allow-all packages/fsm-async-worker-ts/src/cli/async-operation-ctl.ts \
  -c list-meta

# Manually enqueue an async-operation instance
deno run --allow-all packages/fsm-async-worker-ts/src/cli/async-operation-ctl.ts \
  -c dispatch \
  -n checkBureau -v 1 -t internalAsyncOperation \
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
    "async-operation-ctl": "deno run --allow-all src/cli/async-operation-ctl.ts",
    "async-operation-workerlet": "deno run --allow-all src/cli/async-operation-workerlet.ts",
    "async-operation-scheduler": "deno run --allow-all src/cli/async-operation-scheduler.ts",
    "check": "deno check src/index.ts"
  }
}
```

Run from `packages/fsm-async-worker-ts/`, each task takes the CLI's own flags
after the task name, e.g.
`deno task async-operation-workerlet -f <path> -l typescript`. Equivalent direct
invocations from the repo root:

```bash
deno run --allow-all packages/fsm-async-worker-ts/src/cli/async-operation-ctl.ts -c <command> [options]
deno run --allow-all packages/fsm-async-worker-ts/src/cli/async-operation-workerlet.ts -f <path> -l typescript -t internalAsyncOperation
deno run --allow-all packages/fsm-async-worker-ts/src/cli/async-operation-scheduler.ts
```

---

## `--folder-path` structure expected

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
`startFSMAsyncOperationWorker`
(`asyncOperationWorkerlet/fsmasyncoperationworker.ts`) loads each actor from its
own file at runtime, using the module path and export name already resolved
during validation (`ActorPluginValidationResult.fsmModulePath` / `.method`) — no
aggregating `actors/index.ts` is needed or read.

Any of these subdirectories may be absent if the FSM does not use that feature
type. The path is validated at startup — an invalid path exits with code 1
before any database connection is made.

---

## Exit codes

| Code | Meaning                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------------- |
| `0`  | Command completed (or long-running daemon exited) successfully                                                       |
| `1`  | Missing required arguments, invalid folder path, failed to acquire lock, failed to create instance, or runtime error |
