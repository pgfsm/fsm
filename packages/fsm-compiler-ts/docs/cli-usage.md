# fsm-compiler-ts CLI — Usage Reference

## Prerequisites

- **Deno** (see `.prototools` for pinned version)
- **`.env` file** with `DATABASE_URL` set — required only for `load`, `load-and-validate`, `load-and-validate-promise`
- Run all commands from the **repo root**

## Invocation

```
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts -c <command> -f <folder> [options]
```

---

## Global Options

| Flag | Alias | Description |
|---|---|---|
| `--command <command>` | `-c` | Command to run (required) |
| `--folder <folder>` | `-f` | Path to FSM folder, relative to repo root (required) |
| `--workflow-type <type>` | `-w` | Workflow type — required for `validate-plugin`, `validate-promise-plugin`, `load`, `load-and-validate`, `load-and-validate-promise` |
| `--show-recommendation` | `-r` | Validate generated `fsm.json` against schema and print issues (`generate` only) |
| `--help` | `-h` | Show help message |

### Workflow Types

| Value | Description |
|---|---|
| `fsm` | Standard FSM definition |
| `sharedFsm` | Shared FSM used as a child actor |
| `sharedPromise` | Shared promise-based actor |
| `promise` | Promise workflow |

---

## Commands

### `generate`

Generate `fsm.json` and `xstate-fsm.json` from `machine.ts` files.

Walks `<folder>`, finds every versioned subdirectory (e.g. `creditCheck/v01/`), imports `machine.ts`, and writes `fsm.json` and `xstate-fsm.json` alongside it.

```bash
# Generate for standard FSM folder
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate \
  -f apps/fsm-core-example/fsm

# Generate and validate output against schema
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate \
  -f apps/fsm-core-example/fsm \
  --show-recommendation
```

> **Note:** `--workflow-type` is currently ignored for this command — it defaults to `"fsm"`. See [cli-gaps.md](./cli-gaps.md).

---

### `generate-plugin`

Generate TypeScript plugin stub files (`typescript/actions/index.ts`, `typescript/actors/index.ts`, etc.) from an existing `fsm.json`.

Useful for bootstrapping a new FSM — run `generate` first, then `generate-plugin`.

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate-plugin \
  -f apps/fsm-core-example/fsm
```

> **Note:** `--workflow-type` is currently ignored — defaults to `"fsm"`. See [cli-gaps.md](./cli-gaps.md).

---

### `delete`

Delete all generated `fsm.json` and `xstate-fsm.json` files from a folder tree.

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c delete \
  -f apps/fsm-core-example/fsm
```

> **Note:** `--workflow-type` is currently ignored — defaults to `"fsm"`. See [cli-gaps.md](./cli-gaps.md).

---

### `validate-plugin`

Validate that all TypeScript plugin modules (actions, guards, delays, actors) export the functions referenced in `fsm.json`. Does not require a database connection.

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-plugin \
  -f apps/fsm-core-example/fsm \
  -w fsm

# Shared FSM folder
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-plugin \
  -f apps/fsm-core-example/sharedFSM \
  -w sharedFsm
```

**Required:** `-w / --workflow-type`

---

### `load`

Load `fsm.json` files into the database. Requires `DATABASE_URL` in `.env`.

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c load \
  -f apps/fsm-core-example/fsm \
  -w fsm
```

**Required:** `-w / --workflow-type`, `DATABASE_URL` env var

---

### `load-and-validate`

Load FSM JSON into the database and verify plugin module exports in one step. Requires `DATABASE_URL` in `.env`.

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c load-and-validate \
  -f apps/fsm-core-example/fsm \
  -w fsm
```

**Required:** `-w / --workflow-type`, `DATABASE_URL` env var

---

### `load-and-validate-promise`

Load a promise-based workflow folder into the database and verify exports. Requires `DATABASE_URL` in `.env`.

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c load-and-validate-promise \
  -f apps/fsm-core-example/sharedFSM \
  -w sharedPromise
```

**Required:** `-w / --workflow-type`, `DATABASE_URL` env var

---

## Typical Workflow

```bash
# 1. Generate fsm.json from machine.ts
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts -c generate -f apps/fsm-core-example/fsm

# 2. Generate plugin stubs (if starting fresh)
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts -c generate-plugin -f apps/fsm-core-example/fsm

# 3. Validate plugin exports without DB
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts -c validate-plugin -f apps/fsm-core-example/fsm -w fsm

# 4. Load into DB and verify
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts -c load-and-validate -f apps/fsm-core-example/fsm -w fsm
```

---

## Known Limitations

See [cli-gaps.md](./cli-gaps.md) for the full audit. Key points:

- `--workflow-type` is **ignored** for `generate`, `generate-plugin`, and `delete` — hardcoded to `"fsm"`
- `--skip-dirs` flag does not exist — subdirectories cannot be excluded
- `--available-actors` flag does not exist — external actor dependencies are always reported as unresolved by `validate-plugin` and `load-and-validate`
- `validatePromisePluginLoadFromFolders` is available as `validate-promise-plugin`
- No early validation that `--folder` exists or that `DATABASE_URL` is set
