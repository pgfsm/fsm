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

| Flag                        | Alias | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--command <command>`       | `-c`  | Command to run (required)                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--folder <folder>`         | `-f`  | Path to FSM folder, `.ts` file, or `fsm.json` file (required; a single `.ts` file is accepted for `generate` only, and requires `--output`; a single `fsm.json` file is accepted for `generate-sync-logic`/`generate-async-logic` only, and requires `--output`)                                                                                                                                                                                           |
| `--workflow-type <type>`    | `-w`  | Workflow type — required for `validate-sync-operation`, `validate-async-operation`, `load`                                                                                                                                                                                                                                                                                                                                                                 |
| `--db-url <url>`            | `-d`  | PostgreSQL connection string — overrides `DATABASE_URL` env var                                                                                                                                                                                                                                                                                                                                                                                            |
| `--skip-dirs <dirs>`        | `-s`  | Comma-separated subdirectory names to skip when walking `<folder>`                                                                                                                                                                                                                                                                                                                                                                                         |
| `--available-actors <file>` | `-a`  | Path to a JSON file listing actor names available to resolve (used by `validate-sync-operation`, `validate-async-operation`)                                                                                                                                                                                                                                                                                                                               |
| `--lang <langs>`            | `-l`  | Comma-separated language(s): `typescript`, `python`, `rust`, `go`. For `generate-sync-logic` defaults to `typescript`; for `validate-async-operation` defaults to all languages (omit to check all); for `create-async-logic` exactly one language is required                                                                                                                                                                                             |
| `--version <version>`       | `-v`  | FSM version folder name, e.g. `v01` (`create-async-logic` only, required)                                                                                                                                                                                                                                                                                                                                                                                  |
| `--output <folder>`         | `-o`  | Version folder to write generated output into, required when `-f`/`--folder` is a single `machine.ts` file (`generate`) or a single `fsm.json` file (`generate-sync-logic`/`generate-async-logic`); unused otherwise. Relative (resolved against the current working directory) or absolute — independent of `--folder`'s location. For `generate-async-logic` single-`fsm.json` mode, also doubles as where the aggregate registry/worker SDK get written |
| `--name <name>`             | `-n`  | Actor function name, used for `<name>/<name>.ext` (`create-async-logic` only, required)                                                                                                                                                                                                                                                                                                                                                                    |
| `--show-recommendation`     | `-r`  | Validate generated `fsm.json` against schema and print issues (`generate` only)                                                                                                                                                                                                                                                                                                                                                                            |
| `--help`                    | `-h`  | Show help message                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### Workflow Types

| Value                    | Description                        |
| ------------------------ | ---------------------------------- |
| `fsm`                    | Standard FSM definition            |
| `sharedAsyncOperation`   | Shared async-operation-based actor |
| `internalAsyncOperation` | Async operation workflow           |

---

## Commands

### `generate`

Compiles FSM source into `fsm.json` and `xstate-fsm.json`. Accepts two input
types detected from the `-f` path:

- **Directory** — walks the tree, finds every versioned subdirectory (e.g.
  `creditCheck/v01/`), and compiles each `machine.ts` found
- **`.ts` file** — compiles that single `machine.ts` directly; version is
  derived from the parent directory name. Requires `-o`/`--output`: the version
  folder to write `fsm.json`/`xstate-fsm.json` into, independent of
  `machine.ts`'s own location

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
  -f apps/fsm-core-example/fsm/creditCheck/v01/machine.ts \
  --output apps/fsm-core-example/fsm/creditCheck/v01
```

---

### `generate-async-logic`

Scaffold **actor** stubs (from each state's `invoke` objects) — one file per
invoke at `<lang>/actors/<src>/<src>.<ext>` (a subfolder named after the actor
`src`), each exporting a function named after the actor `src`. Each actor is
generated in the language declared by its invoke object's
`asyncOperationLanguage` (default `typescript`).

Useful for bootstrapping a new FSM — run `generate` first, then
`generate-async-logic`. Accepts two input types detected from the `-f` path:

- **Directory** — walks the tree, scaffolds actor files, manifest, barrel, and
  registry for every versioned subdirectory's `fsm.json`.
- **Single `fsm.json` file** — scaffolds actor files/manifest/barrel/registry
  for just that one file. Requires `-o`/`--output`: the version folder to write
  into (a plain path, resolved independently of `--folder`).

**There's no separate flag for where the aggregate lands.** Both modes also
refresh the aggregate registry and worker SDK — one per language, combining
every FSM version's actors — written under `worker-sdk-generated/<lang>/`, one
level above `--folder` (the app root — matching the layout
`apps/fsm-core-example/` uses, where `worker-sdk-generated/` sits beside `fsm/`,
not inside it) in directory mode, or inside `--output` in single-file mode. It
is _not_ re-walked to find actors. The actor set to aggregate always comes from
the real FSM tree instead — `--folder`'s own walk in directory mode, or the
target `fsm.json`'s own location (found by walking three directories up:
`fsm.json` → `<version>` → `<fsmName>` → plugin root) in single-file mode.

```bash
# Directory mode — every versioned FSM under fsm/, plus the aggregate registry/worker SDK
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate-async-logic \
  -f apps/fsm-core-example/fsm

# Single fsm.json mode
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate-async-logic \
  -f apps/fsm-core-example/fsm/creditCheck/v01/fsm.json \
  --output apps/fsm-core-example/fsm/creditCheck/v01
```

---

### `generate-sync-logic`

Scaffold **action / guard / delay** stubs into
`<lang>/{actions,guards,delays}/<index-module>` for each language passed via
`--lang` (comma-separated; `typescript`, `python`, `rust`, `go`; default
`typescript`). Accepts two input types detected from the `-f` path:

- **Directory** — walks the tree, scaffolds stubs for every versioned
  subdirectory's `fsm.json`
- **Single `fsm.json` file** — scaffolds stubs for just that one file. Requires
  `-o`/`--output`: the version folder to write the
  `<lang>/{actions,guards,delays}` stubs into. `--output` is a plain path
  (relative, resolved against the current working directory, or absolute) — it
  is never derived from `--folder`, so the `fsm.json` doesn't need to sit inside
  (or anywhere near) the folder stubs get written to.

```bash
# Directory mode — every versioned FSM under fsm/
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate-sync-logic \
  -f apps/fsm-core-example/fsm \
  --lang typescript,python

# Single fsm.json mode
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate-sync-logic \
  -f apps/fsm-core-example/fsm/creditCheck/v01/fsm.json \
  --output apps/fsm-core-example/fsm/creditCheck/v01
```

---

### `create-async-logic`

Scaffold a **single** actor stub in the shared, non-FSM-scoped async-operation
pool — for actors that aren't driven by any one FSM's `invoke` list. Writes one
file at `<folder>/shared-async-op/<version>/<lang>/actors/<name>/<name>.<ext>`,
via the same `writeActorFile` helper `generate-async-logic` uses per invoke
object, so stub content/formatting matches the rest of the pipeline.

Unlike `generate-async-logic` (which walks an FSM folder and bulk-scaffolds from
`fsm.json`), `--folder` here is the **app root** (e.g. `apps/fsm-core-example`),
not an FSM/plugin-root folder.

For `typescript`/`python`/`rust`, also rewrites that language's
`<lang>/actors/generated-registry.*` from every actor currently on disk under
`<version>/<lang>/actors/` (this run's actor included) — so repeated
`create-async-logic` calls accumulate registry entries instead of each one
clobbering the last. Every entry's identity is fixed: `parentFsmName` and
`asyncOperationType` are always `"sharedAsyncOp"` (these actors have no owning
FSM), `asyncOperationName` is the actor name, and
`parentFsmVersion`/`asyncOperationVersion` are both `--version`. Go has no
per-version registry — each Go actor is already its own Go module (see its own
`go.mod`), so only the actor file is written for `go`.

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c create-async-logic \
  -f apps/fsm-core-example \
  --lang typescript \
  --version v01 \
  --name checkCreditScore
```

**Required:** `-l/--lang` (exactly one language), `-v/--version`, `-n/--name`

---

### `delete`

Delete all generated `fsm.json` and `xstate-fsm.json` files from a folder tree.

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c delete \
  -f apps/fsm-core-example/fsm
```

---

## Validate operation logic

Once the stubs from `generate-async-logic` / `generate-sync-logic` are filled
in, validate that each async operation-logic module and each sync `action` /
`guard` / `delay` actually export what the machine expects. Validation and the
PostgreSQL load are separate steps: each workflow type has its own validate-only
command (below), and a single shared `load` command then loads `fsm.json` into
PostgreSQL.

| Info                  | Async Operation                                                                                                                                                                                                                | Sync Operation                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| PRD                   | [PRD-004](../prd/prd-004-validate-async-operation-logic.md)                                                                                                                                                                    | [PRD-005](../prd/prd-005-validate-sync-operation-logic.md)                                       |
| What it validates     | Each async operation-logic module actually exports its named function                                                                                                                                                          | Every `action`, `guard`, `delay` referenced in `fsm.json` is exported with the right shape       |
| Validate-only command | `validate-async-operation`                                                                                                                                                                                                     | `validate-sync-operation`                                                                        |
| Language scope        | `--lang` (comma-separated) restricts to a language subset; omitted = all actor languages are checked                                                                                                                           | Validates whatever `--lang` languages were scaffolded                                            |
| Per-language check    | Each language's runtime is invoked to confirm the function is defined — not just that the file exists (see the runtime table under `validate-async-operation` below)                                                           | Validated via `validateSyncOperationFromFolder`                                                  |
| Current status        | Not used — `fsm-core-async-op-worker` doesn't need this step. It's a compile-time model, not a runtime one: each lang ipc worker self-registers its actors with the gateway instead of being validated from folders at startup | Used by `fsm-sync-worker-ts` — `fsmlet` runs `validateSyncOperationFromFolders` on every startup |

### `validate-sync-operation`

Validate that all TypeScript plugin modules (actions, guards, delays, actors)
export the functions referenced in `fsm.json`. Does not require a database
connection.

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-sync-operation \
  -f apps/fsm-core-example/fsm \
  -w fsm
```

**Required:** `-w / --workflow-type`

---

### `validate-async-operation`

Validate that every actor module exports its named function, routed by
`asyncOperationLanguage`. Each language is checked by calling its runtime — no
database connection required.

| Language     | Runtime called                               |
| ------------ | -------------------------------------------- |
| `typescript` | `deno run src/checkers/check_fn.ts`          |
| `python`     | `python3 src/checkers/check_fn.py`           |
| `go`         | `go build src/checkers/check_fn.go` → binary |
| `rust`       | `rustc src/checkers/check_fn.rs` → binary    |

Pass `--lang` to restrict which languages are checked (default: all languages
present in the actor folders).

```bash
# Validate all languages (vitalsWorkflow only, via --skip-dirs)
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-async-operation \
  -f apps/fsm-core-example/fsm \
  -w sharedAsyncOperation \
  --skip-dirs carVitals,creditCheck,taskMachineConfig

# TypeScript actors only
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-async-operation \
  -f apps/fsm-core-example/fsm \
  -w sharedAsyncOperation \
  --skip-dirs carVitals,creditCheck,taskMachineConfig \
  --lang typescript

# Multiple languages
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-async-operation \
  -f apps/fsm-core-example/fsm \
  -w sharedAsyncOperation \
  --skip-dirs carVitals,creditCheck,taskMachineConfig \
  --lang typescript,python

# Async operation workflow folder
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-async-operation \
  -f apps/fsm-core-example/fsm \
  -w internalAsyncOperation
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
