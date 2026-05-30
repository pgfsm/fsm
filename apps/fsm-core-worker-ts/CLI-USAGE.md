# fsm-core-worker-ts — CLI Usage Guide

This package provides a CLI for starting and managing FSM queue workers. Workers poll a PGMQ queue, run FSM state transitions (actions, guards, delays), and archive results back to the database.

---

## Prerequisites

1. **Deno 2.6.10** — see `.prototools` at the repo root
2. **Database connection** — one of:
   - `.env` file in the directory you run the CLI from, containing `DATABASE_URL=postgresql://...`
   - `--db-url` / `-d` flag passed directly (takes precedence over `.env`)
3. **FSM folder path** — absolute path to the FSM definition folder (e.g. `apps/fsm-core-example/fsm/creditCheck/v01`). This folder must contain subdirectories for `actions/`, `guards/`, `delays/`, and/or `actors/` with TypeScript module files.

---

## Running the CLI

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

Start a polling worker on an existing PGMQ queue. Does **not** acquire a DB advisory lock.

> **No HTTP equivalent** — the API always uses the lock variant. Use `start-worker-with-db-lock` or `POST /fsm/start` for production.

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

Start a polling worker with a PostgreSQL advisory lock. Prevents duplicate workers on the same queue. Exits with code 1 if another worker already holds the lock.

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

**`--validate-plugin`** — use `validateFsmPluginLoadFromFolder` instead of direct `import()`. Useful when you want to validate that all required exports (actions/guards/delays/actors) are present before starting.

---

### `start-promise-worker`

Start a promise (actor) worker on an existing PGMQ promise queue. Invokes the named actor function for each queued message.

**HTTP equivalent:** `POST /fsmpromise`
```json
{
  "promise_name": "checkBureau_v01",
  "promise_type": "checkBureau",
  "promise_version": "1",
  "fsm_name": "creditCheck",
  "fsm_version": "1"
}
```

> **Note:** `-n` must be the **parent FSM name** (e.g. `creditCheck`), not the actor name. The actor type is specified separately with `-t`.

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

**`-t / --promise-type`** — the actor/promise type name. Must match an export in the `actors/` folder of the FSM definition.

---

### `create-and-start-worker`

Create a new FSM instance (and its PGMQ queue) then immediately start a worker with a DB advisory lock. This is the most common command for spinning up a fresh workflow.

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

The created FSM instance ID is printed to stdout. The worker then runs indefinitely, polling its queue.

> **Note:** Initial FSM context defaults to `{}`. To pass custom context via HTTP, include `fsm_context` in the request body.

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

> **Note:** `-n` must be the **parent FSM name** (e.g. `creditCheck`), not the actor name.

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

| Flag | Alias | Required by | Description |
|---|---|---|---|
| `--command` | `-c` | all | Command to run (see above) |
| `--queue-name` | `-q` | all except `create-and-start-worker` | PGMQ queue name |
| `--fsm-name` | `-n` | all | FSM definition name |
| `--fsm-version` | `-v` | all | FSM version number |
| `--fsm-folder-path` | `-f` | all | Absolute path to FSM folder (validated at startup) |
| `--promise-type` | `-t` | `start-promise-worker`, `create-and-start-promise-worker` | Actor/promise type name |
| `--db-url` | `-d` | optional | Database connection URL (overrides `DATABASE_URL` from `.env`) |
| `--validate-plugin` | | optional | Use plugin validator instead of direct imports |
| `--help` | `-h` | | Print help and exit |

---

## Graceful shutdown

All commands support graceful and force shutdown via keyboard signals:

| Signal | Behavior |
|---|---|
| **Ctrl+C once** (SIGINT) | Graceful stop — signals the worker loop to exit after the current iteration, then releases the DB advisory lock |
| **Ctrl+C twice** (SIGINT × 2) | Force exit — `Deno.exit(0)` immediately (DB lock released by session-end cleanup) |
| **SIGTERM** | Same as first Ctrl+C — graceful stop |

The worker loop checks the abort signal on each iteration (`while (!signal?.aborted)`), so graceful stop completes within one poll cycle (at most ~30 seconds for the PGMQ visibility timeout, typically 1 second when the queue is idle).

---

## `deno.json` tasks

```json
{
  "tasks": {
    "dev": "deno run --allow-all --watch src/cli/index.ts",
    "cli": "deno run --allow-all src/cli/index.ts",
    "check": "deno check src/index.ts"
  }
}
```

- `deno task dev` — runs with `--watch` (restarts on file change, useful during development)
- `deno task cli` — one-shot run
- `deno task check` — type-check all exports without running

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

Any of these subdirectories may be absent if the FSM does not use that feature type. The path is validated at startup — an invalid path exits with code 1 before any database connection is made.

---

## HTTP API reference

The API server (`apps/fsm-core-ts-hono-deno`) exposes HTTP equivalents for most commands. `verifiedModule` (actor/action folder) is resolved server-side from `verifiedFsmModules` context using `fsm_name` + `fsm_version`.

| HTTP route | CLI equivalent | Body |
|---|---|---|
| `GET /fsm` | — | — |
| `POST /fsm` | `create-and-start-worker` | `{ fsm_name, fsm_version, fsm_context? }` — creates instance + starts worker |
| `POST /fsm/start` | `start-worker-with-db-lock` | `{ queue }` |
| `POST /fsm/stop` | Ctrl+C (graceful) | `{ queue }` |
| `GET /fsm/currentActive` | — | — |
| `POST /fsm/send` | — | `{ fsm_instance_id, event_data }` |
| `GET /fsmpromise` | — | — |
| `POST /fsmpromise` | `start-promise-worker` | `{ promise_name, promise_type, promise_version, fsm_name, fsm_version }` |
| `POST /fsmpromise/create-and-start` | `create-and-start-promise-worker` | `{ queue_name, fsm_name, promise_type, fsm_version }` |

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Worker started (or command completed or gracefully stopped) successfully |
| `1` | Missing required arguments, invalid `--fsm-folder-path`, failed to acquire lock, failed to create instance, or runtime error |
