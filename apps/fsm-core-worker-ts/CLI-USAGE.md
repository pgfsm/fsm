# fsm-core-worker-ts — CLI Usage Guide

This package provides a CLI for starting and managing FSM queue workers. Workers poll a PGMQ queue, run FSM state transitions (actions, guards, delays), and archive results back to the database.

---

## Prerequisites

1. **Deno 2.6.10** — see `.prototools` at the repo root
2. **`.env` file** in the directory you run the CLI from, containing:
   ```
   DATABASE_URL=postgresql://user:password@localhost:5432/dbname
   ```
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

```bash
deno task cli \
  -c start-promise-worker \
  -q <queue-name> \
  -t <promise-type> \
  -n <fsm-name> \
  -v <fsm-version> \
  -f <abs-fsm-folder-path>
```

**Example — credit bureau check actor:**
```bash
deno task cli \
  -c start-promise-worker \
  -q checkBureau_v01 \
  -t checkBureau \
  -n checkBureau \
  -v 1 \
  -f /abs/path/to/apps/fsm-core-example/fsm/creditCheck/v01
```

**`-t / --promise-type`** — the actor/promise type name. Must match an export in the `actors/` folder of the FSM definition.

---

### `create-and-start-worker`

Create a new FSM instance (and its PGMQ queue) then immediately start a worker with a DB advisory lock. This is the most common command for spinning up a fresh workflow.

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

> **Note:** Initial FSM context defaults to `{}`. To pass custom context, use the HTTP API (`POST /fsmworker/create-and-start`) or call `createAndStartFSMWorker()` directly.

---

### `create-and-start-promise-worker`

Create a new PGMQ queue and start a promise worker on it.

```bash
deno task cli \
  -c create-and-start-promise-worker \
  -q <queue-name> \
  -t <promise-type> \
  -n <fsm-name> \
  -v <fsm-version> \
  -f <abs-fsm-folder-path>
```

**Example:**
```bash
deno task cli \
  -c create-and-start-promise-worker \
  -q checkBureau_v01 \
  -t checkBureau \
  -n checkBureau \
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
| `--fsm-folder-path` | `-f` | all | Absolute path to FSM folder |
| `--promise-type` | `-t` | `start-promise-worker`, `create-and-start-promise-worker` | Actor/promise type name |
| `--validate-plugin` | | optional | Use plugin validator instead of direct imports |
| `--help` | `-h` | | Print help and exit |

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

Any of these subdirectories may be absent if the FSM does not use that feature type.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Worker started (or command completed) successfully |
| `1` | Missing required arguments, failed to acquire lock, failed to create instance, or runtime error |
