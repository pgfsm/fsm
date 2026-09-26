# @pgfsm/compiler

FSM JSON compiler for PostgreSQL-backed state machines: generates `fsm.json`
from a folder of state machine definitions, scaffolds the action/guard/delay/
actor stub code each language needs to implement, validates that every reference
in the JSON has a matching implementation, and loads the compiled result into
the database.

## Install

```bash
npx @pgfsm/compiler --help
```

or install it as a dependency / global CLI:

```bash
npm install @pgfsm/compiler
npm install -g @pgfsm/compiler   # for a global `fsm-compiler` command
```

## Usage

Run `npx @pgfsm/compiler --help` for the full flag reference. Every command
below that takes `-f`/`--folder` for a directory — and `-o`/`--output`, for
`generate-fsm-json`/`generate-all` — applies the same rule to that path: it must
**not** start with `.` (use a bare relative path like `fsm`, or an absolute path
— not `./fsm`) and must **not** end with `/`.

### `generate-fsm-json` — compile `fsm.json` from a state machine definition

**Input** — `-f`/`--folder` accepts either:

- A **plugin-root directory** containing one subfolder per FSM name, each with
  version subfolders (`v01`, `v02`, …), each containing a `machine.ts` whose
  default export is an XState machine (from `createMachine(...)`). Version
  folders without a `machine.ts` are skipped, not an error.
- A **single `.ts` file path** — only its containing directory is read from;
  that directory must contain a file literally named `machine.ts` (the filename
  you pass is only used to locate the directory). The version name (used when
  filling in missing `asyncOperationVersion` on invoke actors) is taken from
  that directory's own name, e.g. `.../creditCheck/v01/machine.ts` → `v01`.
  Requires `-o`/`--output`, the version folder to write `fsm.json`/
  `xstate-fsm.json` into: a relative (resolved against the current working
  directory) or absolute path, unrelated to `--folder`'s own location — it does
  not need to be, and is not derived from, machine.ts's containing directory.

Other flags: `-s`/`--skip-dirs` (comma-separated FSM names to skip, directory
mode only), `-r`/`--show-recommendation` (also validates the generated
`fsm.json` against the FSM JSON schema and logs any errors — doesn't change
what's written).

**Output** — per version folder:

- `xstate-fsm.json` — the machine's raw XState-exported JSON
- `fsm.json` — that JSON normalized (actions coerced to `{ type }` objects,
  raise/cancel delay names filled in, invoke actors'
  `asyncOperationType`/`asyncOperationVersion` resolved). This is what every
  other command below reads.

```bash
npx @pgfsm/compiler -c generate-fsm-json -f fsm
npx @pgfsm/compiler -c generate-fsm-json -f fsm --skip-dirs carVitals
npx @pgfsm/compiler -c generate-fsm-json -f apps/fsm-core-example/fsm/creditCheck/v01/machine.ts --output apps/fsm-core-example/fsm/creditCheck/v01
```

The full `fsm.json` spec (states, transitions, guards, actions, actors, delays)
is documented in
[`docs/reference/fsm-definition-format.md`](./docs/reference/fsm-definition-format.md).

### `generate-sync-logic` — scaffold action/guard/delay stubs

Reads a version folder's `fsm.json`, so `generate-fsm-json` must have already
run. Unlike every other command here, output is never written relative to
`--folder` or `--output` — it's always anchored at `Deno.cwd()` (wherever the
CLI is invoked from), so `cd` into the directory you want `sync-worker/` to land
in before running it.

**Input** — `-f`/`--folder` accepts either:

- A **plugin-root directory** — every version folder under it is scaffolded.
- A **single `fsm.json` file path** — only that one version's stubs are
  scaffolded. Requires `-N`/`--fsm-name` and `-V`/`--fsm-version` (there's no
  `--output`, so — unlike `generate-async-logic`'s single-file mode — there's no
  `<fsmName>/<fsmVersion>/fsm.json` folder structure to infer identity from
  either; mirrors `validate-sync-operation`'s own single-file-mode flags).

`-l`/`--lang`: comma-separated `typescript,python,rust,go` (default
`typescript`). `-s`/`--skip-dirs`: directory mode only.

**Output** — always under the reserved `sync-worker/` subfolder at the current
working directory, nested `<lang>/<fsmName>/<fsmVersion>/` deep (folder mode
derives `<fsmName>/<fsmVersion>` per FSM while walking; single-file mode uses
`--fsm-name`/`--fsm-version` directly) — so multiple FSMs/versions scaffolded
from the same working directory don't collide:

- `sync-worker/<lang>/<fsmName>/<fsmVersion>/actions/index.{ts,py}` / `mod.rs` /
  `index.go` — one exported stub per action name in `fsm.json` (built-in
  `xstate.raise`/`xstate.cancel` excluded)
- `sync-worker/<lang>/<fsmName>/<fsmVersion>/guards/...` — one stub per guard
- `sync-worker/<lang>/<fsmName>/<fsmVersion>/delays/...` — one stub per delay

Every stub has a `// TODO: implement` body.

For `typescript` (the only language this is currently written for), also, at
that same `<fsmName>/<fsmVersion>` level:

- `generated-sync-operation-registry.ts` — imports every action/guard/delay stub
  written for that version and combines them into one
  `SyncOperationRegistration[]` (`fsmName`, `fsmVersion`, `syncOperationType` —
  `"action"`/`"guard"`/`"delay"`, `syncOperationName`, `syncOperationLanguage`,
  `handler`), so a worker can register/dispatch without importing each kind's
  module separately.
- `fsm.json` — a copy of that version's `fsm.json`, so this directory is
  self-contained rather than requiring a reader to also reach back to the source
  FSM tree for the FSM definition.

```bash
npx @pgfsm/compiler -c generate-sync-logic -f fsm --lang typescript,python
npx @pgfsm/compiler -c generate-sync-logic -f fsm/creditCheck/v01/fsm.json --fsm-name creditCheck --fsm-version v01
```

### `generate-async-logic` — scaffold actor stubs

Reads a version folder's `fsm.json` (every `invoke` object), so
`generate-fsm-json` must have already run. Like `generate-sync-logic`, output is
never written relative to `--folder` or `--output` — it's always anchored at
`Deno.cwd()` (wherever the CLI is invoked from), so `cd` into the directory you
want `async-worker/` to land in before running it.

**Input** — `-f`/`--folder` accepts either:

- A **plugin-root directory** — every version folder under it is scaffolded.
- A **single `fsm.json` file path** — only that one version's actor
  files/manifest/barrel/registry are scaffolded. Requires `-N`/`--fsm-name` and
  `-V`/`--fsm-version` (there's no `--output`, so there's no
  `<fsmName>/<fsmVersion>/fsm.json` folder structure to infer identity from
  either; mirrors `generate-sync-logic`/`validate-sync-operation`'s own
  single-file-mode flags).

`-s`/`--skip-dirs`: directory mode only.

**Output** — always under the reserved `async-worker/` subfolder at the current
working directory. Per `<lang>/<fsmName>/<fsmVersion>/` (folder mode derives
`<fsmName>/<fsmVersion>` per FSM while walking; single-file mode uses
`--fsm-name`/`--fsm-version` directly):

- One file per distinct actor:
  `async-worker/<lang>/<fsmName>/<fsmVersion>/actors/<name>/<name>.<ext>`, where
  `<lang>` is that invoke object's own `asyncOperationLanguage` (default
  `typescript`)
- `actors-manifest.json` — that language's actors, written only for languages
  this version actually used
- A barrel re-exporting each actor: `actors/index.ts` (TS), `actors/__init__.py`
  (Python), `actors/mod.rs` (Rust) — Go has no barrel
- `async-worker/<lang>/<fsmName>/<fsmVersion>/generated-registry.*` (TS/Python/
  Rust) — one level above `actors/`, not inside it — written only when that
  language has at least one actor

Both modes also refresh the aggregate registry plus worker SDK — one per
language, combining every FSM version's actors — since a worker process serves
its language's actors across every FSM, not just one, at `async-worker/<lang>/`
directly (for TypeScript, `run-async-worker.ts` plus a `deno.json` pinning the
published `@pgfsm/async-worker-sdk` package;
`typescript-actors-registry.generated.ts`, etc. — alongside every
`<fsmName>/<fsmVersion>/` this run wrote for that language). Regenerating also
removes a `cli.ts`/`sdk.ts` left by an older compiler version, as long as it
still has the auto-generated header. The actor set aggregated always comes from
the real FSM tree, regardless: `--folder`'s own walk in directory mode, or the
target `fsm.json`'s own location (found by walking three directories up) in
single-file mode.

```bash
npx @pgfsm/compiler -c generate-async-logic -f apps/fsm-core-example/fsm
npx @pgfsm/compiler -c generate-async-logic -f apps/fsm-core-example/fsm/creditCheck/v01/fsm.json --fsm-name creditCheck --fsm-version v01
```

### `generate-all` — run all three generate steps in sequence

Runs `generate-fsm-json`, then `generate-async-logic`, then
`generate-sync-logic` — for a fresh FSM (or a whole plugin-root tree), one
invocation instead of three. Accepts three input shapes:

- **Directory** — runs all three steps across every versioned FSM under the
  folder. A step's own best-effort walk collects failures per FSM without
  stopping (same as running the three commands separately would); one FSM's
  failure in an earlier step doesn't block the next step from still running for
  whichever FSMs did succeed. The command still exits non-zero if anything
  failed anywhere. Unlike the standalone `generate-sync-logic`/
  `generate-async-logic` commands (always `Deno.cwd()`), `generate-all`'s own
  async-/sync-logic steps write to
  `<appRoot>/async-worker/typescript/<fsmName>/<fsmVersion>/`/
  `<appRoot>/sync-worker/typescript/<fsmName>/<fsmVersion>/` — the app root, one
  level above `--folder`.
- **Single `.ts` file** — chains all three steps for just that one FSM version.
  Requires `-o`/`--output`, which serves `fsm.json`/`xstate-fsm.json`; the actor
  stubs + aggregate registry and the sync stubs also write under `--output`, but
  nested `async-worker/typescript/<fsmName>/<fsmVersion>/`/
  `sync-worker/typescript/<fsmName>/<fsmVersion>/` deep rather than directly
  into it (`<fsmName>`/`<fsmVersion>` derived from `--output`'s own path). As
  with `generate-async-logic`'s own aggregate step, `--output` should sit at the
  conventional `<pluginRoot>/<fsmName>/<version>` depth so both that step and
  this identity derivation work.
- **Single `fsm.json` file** — the `fsm.json` already exists, so
  `generate-fsm-json` is skipped entirely; only `generate-async-logic` and
  `generate-sync-logic` run against it, same as passing that `fsm.json` to
  either of those commands individually (`fsm.json`'s own location must sit at
  the same conventional depth for both commands' identity derivation to work).
  Also requires `-o`/`--output`.

`-s`/`--skip-dirs`, `-r`/`--show-recommendation` (step 1), and `-l`/`--lang`
(step 3) all apply, same as the individual commands.

```bash
npx @pgfsm/compiler -c generate-all -f apps/fsm-core-example/fsm
npx @pgfsm/compiler -c generate-all -f apps/fsm-core-example/fsm/creditCheck/v01/machine.ts --output apps/fsm-core-example/fsm/creditCheck/v01
npx @pgfsm/compiler -c generate-all -f apps/fsm-core-example/fsm/creditCheck/v01/fsm.json --output apps/fsm-core-example/fsm/creditCheck/v01
```

### `create-async-logic` — scaffold one actor outside any FSM's `invoke` list

For actors in the shared, non-FSM-scoped async-operation pool. For actors that
belong to an FSM's `invoke` list, use `generate-async-logic` instead.

Unlike every other command here, this one takes **no `-f`/`--folder`** at all —
output is always anchored at `Deno.cwd()` (wherever the CLI is invoked from), so
`cd` into the app root you want `async-worker/` to land in before running it
(e.g. `apps/fsm-core-example`).

**Input** — `-l`/`--lang`: exactly one language, required.
`-n`/`--function-name`: function name, required. `-F`/`--function-version`:
version name matching `v\d{2}` (e.g. `v01`), required. Unrelated to
`-N`/`--fsm-name`/`-V`/`--fsm-version` — these actors have no owning FSM.

**Output** — always under the reserved `async-worker/` subfolder at the current
working directory:

- `async-worker/<lang>/sharedAsyncOperation/<functionVersion>/actors/<functionName>/<functionName>.<ext>`
- `async-worker/<lang>/sharedAsyncOperation/<functionVersion>/actors-manifest.json`,
  rewritten from every shared-async-op actor currently on disk for that language
  _at that one `functionVersion`_ (every language, including Go).
- For `typescript`/`python`/`rust`, an actors barrel re-exporting every
  shared-async-op actor currently on disk for that language _at that one
  `functionVersion`_, at
  `async-worker/<lang>/sharedAsyncOperation/<functionVersion>/actors/<barrel file>`
  (`index.ts`/`__init__.py`/`mod.rs`).
- For `typescript`/`python`/`rust`, that language's registry file at
  `async-worker/<lang>/sharedAsyncOperation/<functionVersion>/generated-registry.<ext>`
  (`generated_registry.py` for Python specifically — its dotted `import` syntax
  can't reference a hyphenated module name), rewritten from every
  shared-async-op actor currently on disk for that language _at that one
  `functionVersion`_ (not a global file across every version).
- For `go`, its own aggregate at
  `async-worker/go/sharedAsyncOperation/go-actors-registry-generated/`
  (`go.mod` + `registry.go`, one `require`+`replace` per actor's own standalone
  Go module — Go actors can't share a flat registry file the way TS/Python/Rust
  do).

Neither ever touches the FSM-scoped aggregate
(`<lang>-actors-registry.generated.ts`) — this pool is fully separate.

```bash
cd apps/fsm-core-example
npx @pgfsm/compiler -c create-async-logic --lang typescript --function-name checkCreditScore --function-version v01
```

### `delete` — remove generated files

**Input** — `-f`/`--folder`: plugin-root directory. `-s`/`--skip-dirs`.

**Output/side effect** — per version folder, removes `fsm.json`,
`xstate-fsm.json` and the `typescript/`/`python/` subdirectories, if present
(`rust/`/`go/` are left alone); also removes that FSM/version's
`{cwd}/sync-worker/typescript/<fsmName>/<fsmVersion>/` (`generate-sync-logic`'s
own output location — see above — not a subdirectory of the version folder
itself). Missing files are skipped silently, not an error.

```bash
npx @pgfsm/compiler -c delete -f fsm
```

### `validate-sync-operation` — check action/guard/delay stubs are implemented

**Input** — `-f`/`--folder`: plugin-root directory. `-s`/`--skip-dirs`.

**Output** — writes nothing; validates that every action/guard/delay in
`fsm.json` has a matching export in
`{cwd}/sync-worker/<lang>/<fsmName>/<fsmVersion>/actions|guards|delays/index.*`
(the same location `generate-sync-logic` writes to) and logs a pass/fail result
per method.

```bash
npx @pgfsm/compiler -c validate-sync-operation -f fsm
```

### `load` — load a compiled `fsm.json` into the database

**Input** — `-f`/`--folder`: plugin-root directory (each version folder's
`fsm.json` must already exist). `-d`/`--db-url` (or the `DATABASE_URL` env var).
`-s`/`--skip-dirs`.

**Output/side effect** — inserts each FSM's states/transitions into the
`fsm_core` PostgreSQL schema, resolving `dependent_children` from any invoke
actors whose `asyncOperationType` is `"fsm"`. No local files are written.

```bash
npx @pgfsm/compiler -c load -f fsm -d "$DATABASE_URL"
```

## Programmatic usage

```typescript
import {
  generateAsyncOperationLogicFromFolders, // scaffold actor stubs
  generateFsmJSONFromFolders, // generate fsm.json for every FSM under a folder tree
  generateSyncOperationLogicFromFolders, // scaffold action/guard/delay stubs
  loadFsmJSONFromFolders, // load compiled fsm.json into the database
  validateSyncOperationFromFolders, // check action/guard/delay stubs are implemented
} from "@pgfsm/compiler";

import type { OperationLang, WorkflowType } from "@pgfsm/compiler";
// WorkflowType  = "fsm" | "sharedAsyncOperation" | "internalAsyncOperation"
// OperationLang = "typescript" | "python" | "rust" | "go"
```

`generateAsyncOperationLogicFromFolders`'s 3rd parameter, `writeRootAbsPath`, is
required — a pure write destination for the aggregate registry/worker SDK (see
the CLI section above for what it does and doesn't control). The CLI itself has
no dedicated flag for it: it passes `--folder`'s own value in directory mode, or
`--output`'s in single-file mode.

The REST API and workers use these at startup to discover and validate FSM
plugins before accepting requests.

## License

Apache-2.0
