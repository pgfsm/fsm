# fsm-compiler-ts CLI — Usage Reference

**npm package:** `@pgfsm/compiler`

## Prerequisites

- **Deno** (see `.prototools` for pinned version)
- **PostgreSQL connection string** — required for `load`,
  `validate-sync-operation-and-load`, `validate-async-operation-and-load`.
  Provide via `--db-url <url>` or set `DATABASE_URL` in a `.env` file (CLI arg
  takes precedence)
- Run all commands from the **repo root**

## Invocation

```
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts -c <command> -f <folder> [options]
```

---

## Global Options

| Flag                        | Alias | Description                                                                                                                                                                                           |
| --------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--command <command>`       | `-c`  | Command to run (required)                                                                                                                                                                             |
| `--folder <folder>`         | `-f`  | Path to FSM folder or `.ts` file (required; a single `.ts` file is accepted for `generate` only)                                                                                                      |
| `--workflow-type <type>`    | `-w`  | Workflow type — required for `validate-sync-operation`, `validate-async-operation`, `load`, `validate-sync-operation-and-load`, `validate-async-operation-and-load`                                   |
| `--db-url <url>`            | `-d`  | PostgreSQL connection string — overrides `DATABASE_URL` env var                                                                                                                                       |
| `--skip-dirs <dirs>`        | `-s`  | Comma-separated subdirectory names to skip when walking `<folder>`                                                                                                                                    |
| `--available-actors <file>` | `-a`  | Path to a JSON file listing actor names available to resolve (used by `validate-sync-operation`, `validate-async-operation`, `validate-sync-operation-and-load`, `validate-async-operation-and-load`) |
| `--lang <langs>`            | `-l`  | Comma-separated target language(s) for `generate-sync-logic`: `typescript`, `python`, `rust`, `go` (default `typescript`)                                                                             |
| `--show-recommendation`     | `-r`  | Validate generated `fsm.json` against schema and print issues (`generate` only)                                                                                                                       |
| `--help`                    | `-h`  | Show help message                                                                                                                                                                                     |

### Workflow Types

| Value           | Description                      |
| --------------- | -------------------------------- |
| `fsm`           | Standard FSM definition          |
| `sharedFsm`     | Shared FSM used as a child actor |
| `sharedPromise` | Shared promise-based actor       |
| `promise`       | Promise workflow                 |

---

## Commands

### `generate`

Compiles FSM source into `fsm.json` and `xstate-fsm.json`. Accepts two input
types detected from the `-f` path:

- **Directory** — walks the tree, finds every versioned subdirectory (e.g.
  `creditCheck/v01/`), and compiles each `machine.ts` found
- **`.ts` file** — compiles that single `machine.ts` directly; version is
  derived from the parent directory name

```bash
# Generate for standard FSM folder (walks all versioned subdirectories)
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate \
  -f apps/fsm-core-example/fsm

# Generate and validate output against schema
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate \
  -f apps/fsm-core-example/fsm \
  --show-recommendation

# Generate from a single machine.ts file
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate \
  -f apps/fsm-core-example/fsm/creditCheck/v01/machine.ts
```

---

### `generate-async-logic`

Scaffold **actor** stubs (from each state's `invoke` objects) — one file per
invoke at `<lang>/actors/<fsmType>_<fsmVersion>_<src>.<ext>`, each exporting a
function named after the actor `src`. Each actor is generated in the language
declared by its invoke object's `fsmLanguage` (default `typescript`).

Useful for bootstrapping a new FSM — run `generate` first, then
`generate-async-logic`.

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate-async-logic \
  -f apps/fsm-core-example/fsm
```

---

### `generate-sync-logic`

Scaffold **action / guard / delay** stubs into
`<lang>/{actions,guards,delays}/<index-module>` for each language passed via
`--lang` (comma-separated; `typescript`, `python`, `rust`, `go`; default
`typescript`).

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate-sync-logic \
  -f apps/fsm-core-example/fsm \
  --lang typescript,python
```

---

### `delete`

Delete all generated `fsm.json` and `xstate-fsm.json` files from a folder tree.

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c delete \
  -f apps/fsm-core-example/fsm
```

---

### `validate-sync-operation`

Validate that all TypeScript plugin modules (actions, guards, delays, actors)
export the functions referenced in `fsm.json`. Does not require a database
connection.

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-sync-operation \
  -f apps/fsm-core-example/fsm \
  -w fsm

# Shared FSM folder
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-sync-operation \
  -f apps/fsm-core-example/sharedFSM \
  -w sharedFsm
```

**Required:** `-w / --workflow-type`

---

### `validate-async-operation`

Validate that all TypeScript plugin modules for a promise-based workflow export
the functions referenced in the FSM definition. Does not require a database
connection.

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-async-operation \
  -f apps/fsm-core-example/sharedFSM \
  -w sharedPromise

# Promise workflow folder
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-async-operation \
  -f apps/fsm-core-example/promise \
  -w promise
```

**Required:** `-w / --workflow-type`

---

### `load`

Load `fsm.json` files into the database.

```bash
# Pass connection string directly
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c load \
  -f apps/fsm-core-example/fsm \
  -w fsm \
  --db-url postgresql://user:pass@localhost:5432/db

# Or rely on DATABASE_URL in .env
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c load \
  -f apps/fsm-core-example/fsm \
  -w fsm
```

**Required:** `-w / --workflow-type`, and either `--db-url` or `DATABASE_URL` in
`.env`

---

### `validate-sync-operation-and-load`

Validate FSM plugin module exports first, then load into the database only if
validation passes.

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-sync-operation-and-load \
  -f apps/fsm-core-example/fsm \
  -w fsm \
  --db-url postgresql://user:pass@localhost:5432/db
```

**Required:** `-w / --workflow-type`, and either `--db-url` or `DATABASE_URL` in
`.env`

---

### `validate-async-operation-and-load`

Validate promise-based workflow plugin exports first, then load into the
database only if validation passes.

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-async-operation-and-load \
  -f apps/fsm-core-example/sharedFSM \
  -w sharedPromise \
  --db-url postgresql://user:pass@localhost:5432/db
```

**Required:** `-w / --workflow-type`, and either `--db-url` or `DATABASE_URL` in
`.env`

---

## Typical Workflow

```bash
# 1. Generate fsm.json from machine.ts
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts -c generate -f apps/fsm-core-example/fsm

# 2. Generate stubs (if starting fresh): actors, then actions/guards/delays
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts -c generate-async-logic -f apps/fsm-core-example/fsm
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts -c generate-sync-logic -f apps/fsm-core-example/fsm --lang typescript

# 3. Validate plugin exports without DB
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts -c validate-sync-operation -f apps/fsm-core-example/fsm -w fsm

# 4. Validate plugins and load into DB
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts -c validate-sync-operation-and-load -f apps/fsm-core-example/fsm -w fsm --db-url postgresql://user:pass@localhost:5432/db
```

---

## Known Limitations

See [cli-gaps.md](./cli-gaps.md) for the full audit.

- `load`, `validate-sync-operation-and-load`, and
  `validate-async-operation-and-load` require a live PostgreSQL connection and
  are not covered by automated tests
- `--skip-dirs` accepts a single string value; to exclude multiple directories,
  pass a comma-separated list (e.g. `-s "node_modules,dist"`) — splitting is
  handled by the called functions
