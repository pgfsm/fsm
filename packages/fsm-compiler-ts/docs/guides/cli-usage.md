# fsm-compiler-ts CLI — Usage Reference

**npm package:** `@pgfsm/compiler`

## Prerequisites

- **Deno** (see `.prototools` for pinned version)
- **PostgreSQL connection string** — required for `load`. Provide via
  `--db-url <url>` or set `DATABASE_URL` in a `.env` file (CLI arg takes
  precedence)
- Run most commands from the **repo root** — `generate-sync-logic`,
  `generate-async-logic`, and `create-async-logic` are the exception: run those
  from **`apps/`** instead (see their own sections below for why)

## Invocation

```
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts -c <command> -f <folder> [options]
```

---

## Global Options

| Flag                      | Alias | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--command <command>`     | `-c`  | Command to run (required)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--folder <folder>`       | `-f`  | Path to FSM folder, `.ts` file, or `fsm.json` file (required for every command except `create-async-logic`, which takes no `--folder` at all — see its own section; a single `.ts` file is accepted for `generate-fsm-json`/`generate-all` only, and requires `--output`; a single `fsm.json` file is accepted for `generate-sync-logic`/`generate-async-logic`/`generate-all`/`validate-sync-operation` — `generate-all` requires `--output`, the other three require `-N`/`--fsm-name` + `-V`/`--fsm-version`)                                  |
| `--db-url <url>`          | `-d`  | PostgreSQL connection string — overrides `DATABASE_URL` env var                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `--skip-dirs <dirs>`      | `-s`  | Comma-separated subdirectory names to skip when walking `<folder>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `--lang <langs>`          | `-l`  | Comma-separated language(s): `typescript`, `python`, `rust`, `go`. For `generate-sync-logic`/`generate-all` defaults to `typescript`; for `validate-async-operation` defaults to all languages (omit to check all); for `create-async-logic` exactly one language is required                                                                                                                                                                                                                                                                     |
| `--fsm-name <name>`       | `-N`  | FSM name, e.g. `creditCheck` (`generate-sync-logic`/`generate-async-logic`/`validate-sync-operation` only, required when `-f`/`--folder` is a single `fsm.json` file — there's no `<fsmName>/<fsmVersion>/fsm.json` folder structure to infer it from)                                                                                                                                                                                                                                                                                            |
| `--fsm-version <version>` | `-V`  | FSM version folder name, e.g. `v01` (`generate-sync-logic`/`generate-async-logic`/`validate-sync-operation` only, required when `-f`/`--folder` is a single `fsm.json` file, alongside `-N`/`--fsm-name`)                                                                                                                                                                                                                                                                                                                                         |
| `--function-name <name>`  | `-n`  | Function name, e.g. `checkCreditScore` (`create-async-logic` only, required — unrelated to `--fsm-name`, these actors have no owning FSM)                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--function-version <v>`  | `-F`  | Function version folder name, e.g. `v01` (`create-async-logic` only, required — unrelated to `--fsm-version`)                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--version`               | `-v`  | Print `@pgfsm/compiler`'s own version and exit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `--output <folder>`       | `-o`  | Version folder to write generated output into, required when `-f`/`--folder` is a single `machine.ts` file (`generate-fsm-json`/`generate-all`) or, for `generate-all` only, a single `fsm.json` file. **Not** used by the standalone `generate-sync-logic`/`generate-async-logic` (those always write to `Deno.cwd()` — see their sections below; use `-N`/`--fsm-name` + `-V`/`--fsm-version` instead for single-`fsm.json` mode). Relative (resolved against the current working directory) or absolute — independent of `--folder`'s location |
| `--show-recommendation`   | `-r`  | Validate generated `fsm.json` against schema and print issues (`generate-fsm-json`/`generate-all` only)                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--help`                  | `-h`  | Show help message                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

---

## Commands

### `generate-fsm-json`

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
  -c generate-fsm-json \
  -f apps/fsm-core-example/fsm

# Generate and validate output against schema
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate-fsm-json \
  -f apps/fsm-core-example/fsm \
  --show-recommendation

# Generate from a single machine.ts file
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate-fsm-json \
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

Useful for bootstrapping a new FSM — run `generate-fsm-json` first, then
`generate-async-logic`. Like `generate-sync-logic`, output is never written
relative to `--folder` or `--output` — it's always anchored at `Deno.cwd()`
(wherever the CLI is invoked from). Run it from **`apps/`** — `async-worker/`
lands there, a sibling of `apps/fsm-core-example/` (not nested inside it — see
#316). Accepts two input types detected from the `-f` path:

- **Directory** — walks the tree, scaffolds actor files, manifest, barrel, and
  registry for every versioned subdirectory's `fsm.json`.
- **Single `fsm.json` file** — scaffolds actor files/manifest/barrel/registry
  for just that one file. Requires `-N`/`--fsm-name` and `-V`/`--fsm-version`
  (there's no `--output`, so there's no `<fsmName>/<fsmVersion>/fsm.json` folder
  structure to infer identity from either).

**Output** — always under the reserved `async-worker/` subfolder at the current
working directory, nested `<lang>/<fsmName>/<fsmVersion>/` deep (folder mode
derives `<fsmName>/<fsmVersion>` per FSM while walking; single-file mode uses
`--fsm-name`/`--fsm-version` directly) — so multiple FSMs/versions scaffolded
from the same working directory don't collide, and so the per-FSM actor tree
sits right beside that language's aggregate registry/worker SDK (`cli.ts`,
`sdk.ts`, `<lang>-actors-registry.generated.ts`, etc. — written once per
language at `async-worker/<lang>/`, refreshed on every run from the real FSM
tree's own walk, not re-walked from the output itself).

```bash
# Directory mode (from apps/) — every versioned FSM under fsm-core-example/fsm/,
# plus the aggregate registry/worker SDK, landing at ./async-worker/
cd apps
deno run --allow-all ../packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate-async-logic \
  -f fsm-core-example/fsm

# Single fsm.json mode
cd apps
deno run --allow-all ../packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate-async-logic \
  -f fsm-core-example/fsm/creditCheck/v01/fsm.json \
  --fsm-name creditCheck --fsm-version v01
```

---

### `generate-sync-logic`

Scaffold **action / guard / delay** stubs for each language passed via `--lang`
(comma-separated; `typescript`, `python`, `rust`, `go`; default `typescript`).
Output is never written relative to `--folder` or `--output` — it's always
anchored at `Deno.cwd()` (wherever the CLI is invoked from). Run it from
**`apps/`** — `sync-worker/` lands there, a sibling of `apps/fsm-core-example/`
(not nested inside it — see #316). Accepts two input types detected from the
`-f` path:

- **Directory** — walks the tree, scaffolds stubs for every versioned
  subdirectory's `fsm.json`
- **Single `fsm.json` file** — scaffolds stubs for just that one file. Requires
  `-N`/`--fsm-name` and `-V`/`--fsm-version` (there's no `--output`, so there's
  no `<fsmName>/<fsmVersion>/fsm.json` folder structure to infer identity from
  either).

**Output** — always under the reserved `sync-worker/` subfolder at the current
working directory, nested `<lang>/<fsmName>/<fsmVersion>/` deep (folder mode
derives `<fsmName>/<fsmVersion>` per FSM while walking; single-file mode uses
`--fsm-name`/`--fsm-version` directly) — so multiple FSMs/versions scaffolded
from the same working directory don't collide. For `typescript`, also writes
`generated-sync-operation-registry.ts` (combining every action/guard/delay stub
into one array) and a copy of that version's `fsm.json`, both at the same
`<fsmName>/<fsmVersion>` level.

```bash
# Directory mode (from apps/) — every versioned FSM under fsm-core-example/fsm/
cd apps
deno run --allow-all ../packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate-sync-logic \
  -f fsm-core-example/fsm \
  --lang typescript,python

# Single fsm.json mode
cd apps
deno run --allow-all ../packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate-sync-logic \
  -f fsm-core-example/fsm/creditCheck/v01/fsm.json \
  --fsm-name creditCheck --fsm-version v01
```

---

### `generate-all`

Runs `generate-fsm-json`, then `generate-async-logic`, then
`generate-sync-logic` in sequence — one invocation instead of three. Accepts
three input types:

- **Directory** — runs all three steps across every versioned FSM under the
  folder. Each step already walks best-effort on its own (a bad FSM's failure in
  one step doesn't stop the others in that step — see #214/#211); catching each
  step's own error here means a failure in an earlier step also doesn't block
  the next step from still running for whichever FSMs did succeed. The command
  exits non-zero if anything failed anywhere, even though it kept going. Unlike
  the standalone `generate-sync-logic`/`generate-async-logic` commands (always
  `Deno.cwd()`), `generate-all`'s own async-/sync-logic steps write to
  `<appRoot>/async-worker/typescript/<fsmName>/<fsmVersion>/`/
  `<appRoot>/sync-worker/typescript/<fsmName>/<fsmVersion>/` — the app root, one
  level above `--folder`.
- **Single `.ts` file** — chains all three steps for just that one FSM version.
  Requires `-o`/`--output`, which serves `fsm.json`/`xstate-fsm.json`; the actor
  stubs + aggregate registry and the sync stubs also write under `--output`, but
  nested `async-worker/typescript/<fsmName>/<fsmVersion>/`/
  `sync-worker/typescript/<fsmName>/<fsmVersion>/` deep rather than directly
  into it (`<fsmName>`/`<fsmVersion>` derived from `--output`'s own path).
  `--output` should sit at the conventional `<pluginRoot>/<fsmName>/<version>`
  depth so that derivation works.
- **Single `fsm.json` file** — the `fsm.json` already exists, so
  `generate-fsm-json` is skipped; only `generate-async-logic` and
  `generate-sync-logic` run against it, same as passing that `fsm.json` to
  either of those commands individually (`fsm.json`'s own location must sit at
  the same conventional depth for both commands' identity derivation to work).
  Also requires `-o`/`--output`.

`-s`/`--skip-dirs`, `-r`/`--show-recommendation` (step 1),
`-p`/`--worker-sdk-protocol` (step 2), and `-l`/`--lang` (step 3) all apply,
same as running the three commands separately.

```bash
# Directory mode — every versioned FSM under fsm/
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate-all \
  -f apps/fsm-core-example/fsm

# Single machine.ts file mode
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate-all \
  -f apps/fsm-core-example/fsm/creditCheck/v01/machine.ts \
  --output apps/fsm-core-example/fsm/creditCheck/v01

# Single fsm.json file mode — skips generate-fsm-json
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate-all \
  -f apps/fsm-core-example/fsm/creditCheck/v01/fsm.json \
  --output apps/fsm-core-example/fsm/creditCheck/v01
```

---

### `create-async-logic`

Scaffold a **single** actor stub in the shared, non-FSM-scoped async-operation
pool — for actors that aren't driven by any one FSM's `invoke` list. Writes one
file at
`{cwd}/async-worker/<lang>/sharedAsyncOperation/<functionVersion>/actors/<functionName>/<functionName>.<ext>`,
via the same `writeActorFile` helper `generate-async-logic` uses per invoke
object, so stub content/formatting matches the rest of the pipeline.

Unlike every other command here, this one takes **no `-f`/`--folder`** at all —
output is always anchored at `Deno.cwd()` (wherever the CLI is invoked from),
same as `generate-sync-logic`/`generate-async-logic` (#305/#307). Run it from
**`apps/`**, same as those two.

Takes `-n`/`--function-name` and `-F`/`--function-version` — deliberately
separate flags from `-N`/`--fsm-name`/`-V`/`--fsm-version`, since these actors
have no owning FSM at all.

For `typescript`/`python`/`rust`, also rewrites that language's single
**global** registry at
`{cwd}/async-worker/<lang>/sharedAsyncOperation/generated-registry.<ext>` from
every shared-async-op actor currently on disk for that language, across every
`functionVersion` (this run's actor included) — so repeated `create-async-logic`
calls accumulate into one file instead of each one clobbering the last. Unlike
the FSM-scoped registries `generate-async-logic` writes (one per
`<fsmName>/<fsmVersion>`), this is deliberately flat, not partitioned by version
— and it never touches the FSM-scoped aggregate
(`<lang>-actors-registry.generated.ts`), which stays fully separate. Every
entry's identity is fixed: `parentFsmName` and `asyncOperationType` are always
`"sharedAsyncOperation"` (these actors have no owning FSM), `asyncOperationName`
is the function name, and `parentFsmVersion`/`asyncOperationVersion` are both
`--function-version`. Since the same function name can recur across different
`functionVersion`s, each import in the registry is aliased
(`<functionName>_<functionVersion>`) to avoid collisions. Go has no shared
registry — each Go actor is already its own Go module (see its own `go.mod`), so
only the actor file is written for `go`.

```bash
cd apps
deno run --allow-all ../packages/fsm-compiler-ts/src/cli/index.ts \
  -c create-async-logic \
  --lang typescript \
  --function-name checkCreditScore \
  --function-version v01
```

**Required:** `-l/--lang` (exactly one language), `-n/--function-name`,
`-F/--function-version`

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
  -f apps/fsm-core-example/fsm
```

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
  --skip-dirs carVitals,creditCheck,taskMachineConfig

# TypeScript actors only
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-async-operation \
  -f apps/fsm-core-example/fsm \
  --skip-dirs carVitals,creditCheck,taskMachineConfig \
  --lang typescript

# Multiple languages
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-async-operation \
  -f apps/fsm-core-example/fsm \
  --skip-dirs carVitals,creditCheck,taskMachineConfig \
  --lang typescript,python
```

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
  --db-url postgresql://user:pass@localhost:5432/db

# Or rely on DATABASE_URL in .env
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c load \
  -f apps/fsm-core-example/fsm
```

**Required:** either `--db-url` or `DATABASE_URL` in `.env`

`load` is shared by every workflow type — it loads whatever `fsm.json` files it
finds, regardless of whether they're sync- or async-oriented. There is no
`-and-load` variant: `validate-sync-operation-and-load` and
`validate-async-operation-and-load` (which used to combine validation with a DB
write in one command) were removed. Validate first with
`validate-sync-operation` / `validate-async-operation`, then run `load` as a
separate step.

---

## Typical Workflow

`generate-sync-logic`/`generate-async-logic` write to `Deno.cwd()` (see their
sections above), so steps 2-3 below `cd` into `apps/` first — that's where
`sync-worker/`/`async-worker/` should land, as a sibling of
`apps/fsm-core-example/` (see #316). `generate-fsm-json`/`load` don't have this
constraint and can run from the repo root.

```bash
# 1. Generate fsm.json from machine.ts (run from repo root)
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts -c generate-fsm-json -f apps/fsm-core-example/fsm

# 2. Generate stubs (if starting fresh): actors, then actions/guards/delays
cd apps
deno run --allow-all ../packages/fsm-compiler-ts/src/cli/index.ts -c generate-async-logic -f fsm-core-example/fsm
deno run --allow-all ../packages/fsm-compiler-ts/src/cli/index.ts -c generate-sync-logic -f fsm-core-example/fsm --lang typescript
cd ..

# Steps 1-2 combined, in one command (generate-all writes to <appRoot>/async-worker/
# and <appRoot>/sync-worker/ instead -- nested inside apps/fsm-core-example/,
# NOT the apps/-level location above -- the one exception to this convention,
# see its own section above):
# deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts -c generate-all -f apps/fsm-core-example/fsm --lang typescript

# 3. Validate plugin exports without DB
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts -c validate-sync-operation -f apps/fsm-core-example/fsm

# 4. Load into DB once validation passes
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts -c load -f apps/fsm-core-example/fsm --db-url postgresql://user:pass@localhost:5432/db
```

---

## Known Limitations

See [cli-gaps.md](./cli-gaps.md) for the full audit.

- `load` requires a live PostgreSQL connection and is not covered by automated
  tests
- `--skip-dirs` accepts a single string value; to exclude multiple directories,
  pass a comma-separated list (e.g. `-s "node_modules,dist"`) — splitting is
  handled by the called functions
