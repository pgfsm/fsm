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
below that takes `-f`/`--folder` for a directory applies the same rule to that
path: it must **not** start with `.` (use a bare relative path like `fsm`, or an
absolute path — not `./fsm`) and must **not** end with `/`.

### `generate-fsm-json` — compile `fsm.json` from a state machine definition

**Input** — `-f`/`--folder` accepts either:

- A **plugin-root directory** containing one subfolder per FSM name, each with
  version subfolders (`v01`, `v02`, …), each containing a `machine.ts` whose
  default export is an XState machine (from `createMachine(...)`). Version
  folders without a `machine.ts` are skipped, not an error.
- A **single `.ts` file path** — only its containing directory is read from;
  that directory must contain a file literally named `machine.ts` (the filename
  you pass is only used to locate the directory). Requires `-N`/`--fsm-name` and
  `-V`/`--fsm-version`; neither is guessed from the file's folders. The
  `machine.ts` is compiled from where it is (so its imports still resolve), and
  only if compilation succeeds are `fsm.json`/`xstate-fsm.json` written to
  `{cwd}/fsm/<fsmName>/<fsmVersion>/`. `machine.ts` itself is not copied, so
  that folder holds build output unless the `machine.ts` already lives there
  (then it's an in-place compile). `-V` also fills in missing
  `asyncOperationVersion` on invoke actors. If that folder's existing `fsm.json`
  belongs to a different machine `id`, the command refuses unless `--force` is
  passed (only as strong as the ids: machines left at xstate's default
  `(machine)` id all match). There is no `--output`.

Other flags: `-s`/`--skip-dirs` (comma-separated FSM names to skip, directory
mode only), `-r`/`--show-recommendation` (also validates the generated
`fsm.json` against the FSM JSON schema and logs any errors — doesn't change
what's written).

**Output** — per version folder (in place in directory mode;
`{cwd}/fsm/<fsmName>/<fsmVersion>/` for a single `.ts` file):

- `xstate-fsm.json` — the machine's raw XState-exported JSON
- `fsm.json` — that JSON normalized (actions coerced to `{ type }` objects,
  raise/cancel delay names filled in, invoke actors'
  `asyncOperationType`/`asyncOperationVersion` resolved). This is what every
  other command below reads.

```bash
npx @pgfsm/compiler -c generate-fsm-json -f fsm
npx @pgfsm/compiler -c generate-fsm-json -f fsm --skip-dirs carVitals
cd my-app && npx @pgfsm/compiler -c generate-fsm-json -f ~/designs/checkout/machine.ts -N checkout -V v01   # → my-app/fsm/checkout/v01/
```

The full `fsm.json` spec (states, transitions, guards, actions, actors, delays)
is documented in
[`docs/reference/fsm-definition-format.md`](./docs/reference/fsm-definition-format.md).

### `generate-sync-logic` — scaffold action/guard/delay stubs

Reads a version folder's `fsm.json`, so `generate-fsm-json` must have already
run. Output is never written relative to `--folder` — it's always anchored at
`Deno.cwd()` (wherever the CLI is invoked from), so `cd` into the directory you
want `sync-worker/` to land in before running it.

**Input** — `-f`/`--folder` accepts either:

- A **plugin-root directory** — every version folder under it is scaffolded.
- A **single `fsm.json` file path** — only that one version's stubs are
  scaffolded. Requires `-N`/`--fsm-name` and `-V`/`--fsm-version` — identity is
  never inferred from the file's folders (mirrors `validate-sync-operation`'s
  own single-file-mode flags).

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
never written relative to `--folder` — it's always anchored at `Deno.cwd()`
(wherever the CLI is invoked from), so `cd` into the directory you want
`async-worker/` to land in before running it.

**Input** — `-f`/`--folder` accepts either:

- A **plugin-root directory** — every version folder under it is scaffolded.
- A **single `fsm.json` file path** — only that one version's actor
  files/manifest/barrel/registry are scaffolded. Requires `-N`/`--fsm-name` and
  `-V`/`--fsm-version` — identity is never inferred from the file's folders;
  mirrors `generate-sync-logic`/`validate-sync-operation`'s own single-file-mode
  flags).

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
published `@pgfsm/async-worker-sdk` package; for Python, `run_async_worker.py`
plus a uv `pyproject.toml` pinning the published `pgfsm-async-worker-sdk`; for
Rust, `src/main.rs` plus a `Cargo.toml` depending on the published
`pgfsm-async-worker-sdk` crate; for Go, `main.go` plus a `go.mod` requiring the
published `github.com/pgfsm/fsm/packages/fsm-async-worker-sdk-go` module;
`typescript-actors-registry.generated.ts`, etc. — alongside every
`<fsmName>/<fsmVersion>/` this run wrote for that language). Regenerating also
removes a `cli.ts`/`sdk.ts` (TypeScript), `cli.py`/`sdk.py`/`requirements.txt`
(Python), `src/sdk.rs` (Rust) or `sdk.go` (Go) left by an older compiler
version, as long as it still has the auto-generated header. The actor set
aggregated always comes from the real FSM tree, regardless: `--folder`'s own
walk in directory mode, or the target `fsm.json`'s own location (found by
walking three directories up) in single-file mode.

```bash
npx @pgfsm/compiler -c generate-async-logic -f apps/fsm-core-example/fsm
npx @pgfsm/compiler -c generate-async-logic -f apps/fsm-core-example/fsm/creditCheck/v01/fsm.json --fsm-name creditCheck --fsm-version v01
```

**Per-actor concurrency.** Every new actor stub declares how many invokes of
that actor one worker runs at once, next to the handler:
`export const
maxConcurrency = 1;` (TypeScript), `MAX_CONCURRENCY = 1` (Python),
`pub const MAX_CONCURRENCY: u32 = 1;` (Rust), `const MaxConcurrency = 1` (Go).
The generated registries pass it to the worker SDK, which sends it to the
gateway; it wins over the worker's `--max-concurrency`. Raise it only when the
handler is safe to run concurrently, and keep handlers idempotent (delivery is
at-least-once). A stub from an older compiler without the setting still builds:
its actor uses the worker's `--max-concurrency`. Add the line to opt in. A kept
Rust `src/main.rs` from before this needs
`.with_max_concurrency(reg.max_concurrency)` on each registration;
`--overwrite generated-only` reports it.

### `generate-all` — run all three generate steps in sequence

Runs `generate-fsm-json`, then `generate-async-logic`, then
`generate-sync-logic` — for a fresh FSM (or a whole plugin-root tree), one
invocation instead of three. Accepts three input shapes:

- **Directory** — runs all three steps across every versioned FSM under the
  folder. A step's own best-effort walk collects failures per FSM without
  stopping (same as running the three commands separately would); one FSM's
  failure in an earlier step doesn't block the next step from still running for
  whichever FSMs did succeed. The command still exits non-zero if anything
  failed anywhere.
- **Single `.ts` file** — chains all three steps for just that one FSM version.
  `fsm.json`/`xstate-fsm.json` go to `{cwd}/fsm/<fsmName>/<fsmVersion>/`,
  exactly as `generate-fsm-json` does for a single `.ts` file.
- **Single `fsm.json` file** — the `fsm.json` already exists, so
  `generate-fsm-json` is skipped; the file is copied to
  `{cwd}/fsm/<fsmName>/<fsmVersion>/fsm.json` (same machine-`id` guard and
  `--force`) and `generate-async-logic`/`generate-sync-logic` run against it.

Either way the current directory ends up with `fsm/`, `sync-worker/` and
`async-worker/`, and a later `generate-all -f fsm` from there rebuilds it all
without pointing back at the original file.

In every mode, `async-worker/` and `sync-worker/` land under the current working
directory — the same anchor as `generate-sync-logic`/`generate-async-logic` — so
run it from your app root. There is no `--output`. Both single-file modes
require `-N`/`--fsm-name` and `-V`/`--fsm-version`, like the standalone
commands' single-`fsm.json` mode. They are never guessed from the file's parent
folders: `-f a/fsm.json` would otherwise silently become `<cwd's name>/a`.

`-s`/`--skip-dirs`, `-r`/`--show-recommendation` (step 1), and `-l`/`--lang`
(step 3) all apply, same as the individual commands.

```bash
cd apps/fsm-core-example
npx @pgfsm/compiler -c generate-all -f fsm
npx @pgfsm/compiler -c generate-all -f fsm/creditCheck/v01/machine.ts -N creditCheck -V v01
npx @pgfsm/compiler -c generate-all -f fsm/creditCheck/v01/fsm.json -N creditCheck -V v01
npx @pgfsm/compiler -c generate-all -f ~/Downloads/checkout.json -N checkout -V v01
```

### Re-running without losing your code — `--overwrite generated-only`

By default (`--overwrite all`) every command rewrites every file it produces.
`--overwrite generated-only` (on `generate-sync-logic`, `generate-async-logic`,
`generate-all` and `create-async-logic`) instead keeps files that are yours once
created, and rewrites only compiler-owned ones:

| Class      | Files                                                                                                                                                                                                                                        | With `generated-only`   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Generated  | `fsm.json`/`xstate-fsm.json`, every registry and aggregate registry, `actors-manifest.json`, actor barrels, `go-actors-registry-generated/`, and the Go worker's `go.mod` + `main.go`                                                        | Always rewritten        |
| Scaffolded | `actions`/`guards`/`delays` `index.ts`, each actor stub, each Go actor's own `go.mod`, `run-sync-worker.ts`, `run-async-worker.ts`, `run_async_worker.py`, `src/main.rs`, their `deno.json`/`pyproject.toml`/`Cargo.toml`, and `.gitignore`s | Written only if missing |

The Go worker module is generated because its `go.mod` lists every actor module
and must match `main.go`'s SDK pin; add a Go actor's own dependencies to that
actor's `go.mod`. When a kept stub module doesn't define an export the FSM now
needs (e.g. a new action), the command warns with the missing names instead of
rewriting the file. Kept files are never reformatted, and the run ends with a
`created / regenerated / kept` count. This is the mode `@pgfsm/cli` uses.

```bash
npx @pgfsm/compiler -c generate-all -f fsm --overwrite generated-only
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

**Output/side effect** — per version folder, removes `fsm.json` and
`xstate-fsm.json`. Version folders with no `machine.ts` are left alone, since
their `fsm.json` can't be regenerated from there. Missing files are skipped
silently, not an error.

The worker folders `{cwd}/sync-worker/typescript/<fsmName>/<fsmVersion>/` and
`{cwd}/async-worker/<lang>/<fsmName>/<fsmVersion>/` are **kept** by default,
because they hold the stubs you implement; the command logs which ones it kept.
Pass `--include-workers` to remove them too, scoped to the FSM versions being
deleted. The aggregate registries under `sync-worker/typescript/` and
`async-worker/<lang>/` are not rewritten, so re-run `generate-sync-logic`/
`generate-async-logic` afterwards.

```bash
npx @pgfsm/compiler -c delete -f fsm
npx @pgfsm/compiler -c delete -f fsm --include-workers   # also removes implemented stubs
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

### `load` — load a compiled `fsm.json` into the database (deprecated)

> **Deprecated:** use
> [`pgfsmctl fsm load <folder>`](https://www.npmjs.com/package/@pgfsm/ctl) from
> `@pgfsm/ctl` instead (SPEC-006). `load` still works for now, with the same
> behaviour, and prints a warning; it will be removed in a later release.

**Input** — `-f`/`--folder`: plugin-root directory (each version folder's
`fsm.json` must already exist). `-d`/`--db-url` (or the `DATABASE_URL` env var).
`-s`/`--skip-dirs`.

**Output/side effect** — inserts each FSM's states/transitions into the
`fsm_core` PostgreSQL schema, resolving `dependent_children` from any invoke
actors whose `asyncOperationType` is `"fsm"`, as one transaction with child FSMs
loaded before their parents. Identical re-loads are no-ops; any failure loads
nothing and exits non-zero. No local files are written.

```bash
npx @pgfsm/compiler -c load -f fsm -d "$DATABASE_URL"
```

## Programmatic usage

```typescript
import {
  generateAsyncOperationLogicFromFolders, // scaffold actor stubs
  generateFsmJSONFromFolders, // generate fsm.json for every FSM under a folder tree
  generateSyncOperationLogicFromFolders, // scaffold action/guard/delay stubs
  loadFsmJSONFromFolders, // deprecated: load fsm.json into the database (use @pgfsm/db's loadFsmDefinitions)
  validateSyncOperationFromFolders, // check action/guard/delay stubs are implemented
} from "@pgfsm/compiler";

import type { OperationLang, WorkflowType } from "@pgfsm/compiler";
// WorkflowType  = "fsm" | "sharedAsyncOperation" | "internalAsyncOperation"
// OperationLang = "typescript" | "python" | "rust" | "go"
```

`generateAsyncOperationLogicFromFolders`'s 3rd parameter, `writeRootAbsPath`, is
required — a pure write destination for the aggregate registry/worker SDK (see
the CLI section above for what it does and doesn't control). The CLI itself has
no dedicated flag for it: it always passes `Deno.cwd()`. `generateAll` takes the
same value as its `writeRootAbsPath` option.

The REST API and workers use these at startup to discover and validate FSM
plugins before accepting requests.

## License

Apache-2.0
