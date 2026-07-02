# fsm-compiler-ts CLI — Usage Reference

**npm package:** `@pgfsm/compiler`

## Prerequisites

- **Deno** (see `.prototools` for pinned version)
- **PostgreSQL connection string** — required for `load`, `validate-and-load`,
  `validate-and-load-promise`. Provide via `--db-url <url>` or set
  `DATABASE_URL` in a `.env` file (CLI arg takes precedence)
- Run all commands from the **repo root**

## Invocation

```
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts -c <command> -f <folder> [options]
```

---

## Global Options

| Flag                        | Alias | Description                                                                                                                                                           |
| --------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--command <command>`       | `-c`  | Command to run (required)                                                                                                                                             |
| `--folder <folder>`         | `-f`  | Path to FSM folder, `.ts` file, or `.json` file (required; files accepted for `generate` only)                                                                        |
| `--workflow-type <type>`    | `-w`  | Workflow type — required for `validate-plugin`, `validate-promise-plugin`, `load`, `validate-and-load`, `validate-and-load-promise`                                   |
| `--db-url <url>`            | `-d`  | PostgreSQL connection string — overrides `DATABASE_URL` env var                                                                                                       |
| `--skip-dirs <dirs>`        | `-s`  | Comma-separated subdirectory names to skip when walking `<folder>`                                                                                                    |
| `--available-actors <file>` | `-a`  | Path to a JSON file listing actor names available to resolve (used by `validate-plugin`, `validate-promise-plugin`, `validate-and-load`, `validate-and-load-promise`) |
| `--show-recommendation`     | `-r`  | Validate generated `fsm.json` against schema and print issues (`generate` only)                                                                                       |
| `--help`                    | `-h`  | Show help message                                                                                                                                                     |

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

Compiles FSM source into `fsm.json` and `xstate-fsm.json`. Accepts three input
types detected from the `-f` path:

- **Directory** — walks the tree, finds every versioned subdirectory (e.g.
  `creditCheck/v01/`), and compiles each `machine.ts` found
- **`.ts` file** — compiles that single `machine.ts` directly; version is
  derived from the parent directory name
- **`.json` file** — reads the raw XState config, generates a `machine.ts`
  wrapper alongside it (skipped if one already exists), then compiles

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

# Generate from a raw XState config.json
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate \
  -f apps/fsm-core-example/fsm/creditCheck/v01/config.json
```

---

### `generate-plugin`

Generate TypeScript plugin stub files (`typescript/actions/index.ts`,
`typescript/actors/index.ts`, etc.) from an existing `fsm.json`.

Useful for bootstrapping a new FSM — run `generate` first, then
`generate-plugin`.

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate-plugin \
  -f apps/fsm-core-example/fsm
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

### `validate-plugin`

Validate that all TypeScript plugin modules (actions, guards, delays, actors)
export the functions referenced in `fsm.json`. Does not require a database
connection.

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

### `validate-promise-plugin`

Validate that all TypeScript plugin modules for a promise-based workflow export
the functions referenced in the FSM definition. Does not require a database
connection.

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-promise-plugin \
  -f apps/fsm-core-example/sharedFSM \
  -w sharedPromise

# Promise workflow folder
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-promise-plugin \
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

### `validate-and-load`

Validate FSM plugin module exports first, then load into the database only if
validation passes.

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-and-load \
  -f apps/fsm-core-example/fsm \
  -w fsm \
  --db-url postgresql://user:pass@localhost:5432/db
```

**Required:** `-w / --workflow-type`, and either `--db-url` or `DATABASE_URL` in
`.env`

---

### `validate-and-load-promise`

Validate promise-based workflow plugin exports first, then load into the
database only if validation passes.

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-and-load-promise \
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

# 2. Generate plugin stubs (if starting fresh)
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts -c generate-plugin -f apps/fsm-core-example/fsm

# 3. Validate plugin exports without DB
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts -c validate-plugin -f apps/fsm-core-example/fsm -w fsm

# 4. Validate plugins and load into DB
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts -c validate-and-load -f apps/fsm-core-example/fsm -w fsm --db-url postgresql://user:pass@localhost:5432/db
```

---

## Known Limitations

See [cli-gaps.md](./cli-gaps.md) for the full audit.

- `load`, `validate-and-load`, and `validate-and-load-promise` require a live
  PostgreSQL connection and are not covered by automated tests
- `--skip-dirs` accepts a single string value; to exclude multiple directories,
  pass a comma-separated list (e.g. `-s "node_modules,dist"`) — splitting is
  handled by the called functions
