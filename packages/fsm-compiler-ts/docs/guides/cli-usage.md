# fsm-compiler-ts CLI — Usage Reference

**npm package:** `@pgfsm/compiler`

## Prerequisites

- **Deno** (see `.prototools` for pinned version)
- **PostgreSQL connection string** — required for `load`. Provide via
  `--db-url <url>` or set `DATABASE_URL` in a `.env` file (CLI arg takes
  precedence)
- Run all commands from the **repo root**

## Invocation

```
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts -c <command> -f <folder> [options]
```

---

## Global Options

| Flag                        | Alias | Description                                                                                                                                                                                         |
| --------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--command <command>`       | `-c`  | Command to run (required)                                                                                                                                                                           |
| `--folder <folder>`         | `-f`  | Path to FSM folder or `.ts` file (required; a single `.ts` file is accepted for `generate` only)                                                                                                    |
| `--workflow-type <type>`    | `-w`  | Workflow type — required for `validate-sync-operation`, `validate-async-operation`, `load`                                                                                                          |
| `--db-url <url>`            | `-d`  | PostgreSQL connection string — overrides `DATABASE_URL` env var                                                                                                                                     |
| `--skip-dirs <dirs>`        | `-s`  | Comma-separated subdirectory names to skip when walking `<folder>`                                                                                                                                  |
| `--available-actors <file>` | `-a`  | Path to a JSON file listing actor names available to resolve (used by `validate-sync-operation`, `validate-async-operation`)                                                                        |
| `--lang <langs>`            | `-l`  | Comma-separated language(s): `typescript`, `python`, `rust`, `go`. For `generate-sync-logic` defaults to `typescript`; for `validate-async-operation` defaults to all languages (omit to check all) |
| `--show-recommendation`     | `-r`  | Validate generated `fsm.json` against schema and print issues (`generate` only)                                                                                                                     |
| `--help`                    | `-h`  | Show help message                                                                                                                                                                                   |

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
invoke at `<lang>/actors/<src>/<src>.<ext>` (a subfolder named after the actor
`src`), each exporting a function named after the actor `src`. Each actor is
generated in the language declared by its invoke object's `fsmLanguage` (default
`typescript`).

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

Validate that every actor module exports its named function, routed by
`fsmLanguage`. Each language is checked by calling its runtime — no database
connection required.

| Language     | Runtime called                               |
| ------------ | -------------------------------------------- |
| `typescript` | `deno run src/checkers/check_fn.ts`          |
| `python`     | `python3 src/checkers/check_fn.py`           |
| `go`         | `go build src/checkers/check_fn.go` → binary |
| `rust`       | `rustc src/checkers/check_fn.rs` → binary    |

Pass `--lang` to restrict which languages are checked (default: all languages
present in the actor folders).

```bash
# Validate all languages
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-async-operation \
  -f apps/fsm-core-example/sharedFSM \
  -w sharedPromise

# TypeScript actors only
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-async-operation \
  -f apps/fsm-core-example/sharedFSM \
  -w sharedPromise \
  --lang typescript

# Multiple languages
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-async-operation \
  -f apps/fsm-core-example/sharedFSM \
  -w sharedPromise \
  --lang typescript,python

# Promise workflow folder
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-async-operation \
  -f apps/fsm-core-example/promise \
  -w promise
```

**Required:** `-w / --workflow-type`

**Prerequisites:** the runtime for each language being validated must be on
`PATH` (`python3`, `go`, `rustc`).

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

`load` is shared by every workflow type — it loads whatever `fsm.json` files it
finds, regardless of whether they're sync- or async-oriented. There is no
`-and-load` variant: `validate-sync-operation-and-load` and
`validate-async-operation-and-load` (which used to combine validation with a DB
write in one command) were removed. Validate first with
`validate-sync-operation` / `validate-async-operation`, then run `load` as a
separate step.

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

# 4. Load into DB once validation passes
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts -c load -f apps/fsm-core-example/fsm -w fsm --db-url postgresql://user:pass@localhost:5432/db
```

---

## Known Limitations

See [cli-gaps.md](./cli-gaps.md) for the full audit.

- `load` requires a live PostgreSQL connection and is not covered by automated
  tests
- `--skip-dirs` accepts a single string value; to exclude multiple directories,
  pass a comma-separated list (e.g. `-s "node_modules,dist"`) — splitting is
  handled by the called functions
