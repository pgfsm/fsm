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
`generate-fsm-json`/`generate-sync-logic`/`generate-async-logic`/`generate-all`
— applies the same rule to that path: it must **not** start with `.` (use a bare
relative path like `fsm`, or an absolute path — not `./fsm`) and must **not**
end with `/`.

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
run.

**Input** — `-f`/`--folder` accepts either:

- A **plugin-root directory** — every version folder under it is scaffolded.
- A **single `fsm.json` file path** — only that one version's stubs are
  scaffolded. Requires `-o`/`--output`, the version folder to write stubs into:
  a relative (resolved against the current working directory) or absolute path,
  unrelated to `--folder`'s own location — it does not need to be, and is not
  derived from, the fsm.json's containing directory.

`-l`/`--lang`: comma-separated `typescript,python,rust,go` (default
`typescript`). `-s`/`--skip-dirs`: directory mode only.

**Output** — per version folder (or, in single-file mode, into `--output`), per
requested language:

- `<lang>/actions/index.{ts,py}` / `mod.rs` / `index.go` — one exported stub per
  action name in `fsm.json` (built-in `xstate.raise`/`xstate.cancel` excluded)
- `<lang>/guards/...` — one stub per guard
- `<lang>/delays/...` — one stub per delay

Every stub has a `// TODO: implement` body.

```bash
npx @pgfsm/compiler -c generate-sync-logic -f fsm --lang typescript,python
npx @pgfsm/compiler -c generate-sync-logic -f fsm/creditCheck/v01/fsm.json --output fsm/creditCheck/v01
```

### `generate-async-logic` — scaffold actor stubs

Reads a version folder's `fsm.json` (every `invoke` object), so
`generate-fsm-json` must have already run.

**Input** — `-f`/`--folder` accepts either:

- A **plugin-root directory** — every version folder under it is scaffolded.
- A **single `fsm.json` file path** — only that one version's actor
  files/manifest/barrel/registry are scaffolded. Requires `-o`/`--output`, the
  version folder to write into: a relative (resolved against the current working
  directory) or absolute path, unrelated to `--folder`'s own location.

`-p`/`--worker-sdk-protocol`: `grpc` (default) or `legacy` — directory mode
only. `-s`/`--skip-dirs`: directory mode only.

**Output** — per version folder (or, in single-file mode, into `--output`):

- One file per distinct actor: `<lang>/actors/<name>/<name>.<ext>`, where
  `<lang>` is that invoke object's own `asyncOperationLanguage` (default
  `typescript`)
- `actors-manifest.json` — every actor across all languages
- A per-language barrel re-exporting each actor: `typescript/actors/index.ts`,
  `python/actors/__init__.py`, `rust/actors/mod.rs` (Go has no barrel)
- A per-language `generated-registry.*`, written only when that language has at
  least one actor

Both modes also refresh the aggregate registry plus worker SDK — one per
language, combining every FSM version's actors — since a worker process serves
its language's actors across every FSM, not just one. There's no separate flag
for where that aggregate lands: in directory mode it's written one level above
`--folder` (the app root — matching the layout `apps/fsm-core-example/` uses,
where `worker-sdk-generated/` sits beside `fsm/`, not inside it); in single-file
mode it's written to `--output/worker-sdk-generated/<lang>/`. The actor set
aggregated always comes from the real FSM tree, regardless: `--folder`'s own
walk in directory mode, or the target `fsm.json`'s own location (found by
walking three directories up) in single-file mode.

```bash
npx @pgfsm/compiler -c generate-async-logic -f apps/fsm-core-example/fsm
npx @pgfsm/compiler -c generate-async-logic -f apps/fsm-core-example/fsm --worker-sdk-protocol legacy
npx @pgfsm/compiler -c generate-async-logic -f apps/fsm-core-example/fsm/creditCheck/v01/fsm.json --output apps/fsm-core-example/fsm/creditCheck/v01
```

### `generate-all` — run all three generate steps in sequence

Runs `generate-fsm-json`, then `generate-async-logic`, then
`generate-sync-logic` — for a fresh FSM (or a whole plugin-root tree), one
invocation instead of three. Accepts the same two input shapes as
`generate-fsm-json`:

- **Directory** — runs all three steps across every versioned FSM under the
  folder. A step's own best-effort walk collects failures per FSM without
  stopping (same as running the three commands separately would); one FSM's
  failure in an earlier step doesn't block the next step from still running for
  whichever FSMs did succeed. The command still exits non-zero if anything
  failed anywhere.
- **Single `.ts` file** — chains all three steps for just that one FSM version.
  Requires `-o`/`--output`, which serves every step alike: the destination for
  `fsm.json`/`xstate-fsm.json`, the actor stubs + aggregate registry, and the
  sync stubs, all written into the same version folder. As with
  `generate-async-logic`'s own single-file mode, `--output` should sit at the
  conventional `<pluginRoot>/<fsmName>/<version>` depth so the aggregate step
  can find the real plugin root three levels up.

`-s`/`--skip-dirs`, `-r`/`--show-recommendation` (step 1),
`-p`/`--worker-sdk-protocol` (step 2), and `-l`/`--lang` (step 3) all apply,
same as the individual commands.

```bash
npx @pgfsm/compiler -c generate-all -f apps/fsm-core-example/fsm
npx @pgfsm/compiler -c generate-all -f apps/fsm-core-example/fsm/creditCheck/v01/machine.ts --output apps/fsm-core-example/fsm/creditCheck/v01
```

### `create-async-logic` — scaffold one actor outside any FSM's `invoke` list

For actors in the shared, non-FSM-scoped async-operation pool. For actors that
belong to an FSM's `invoke` list, use `generate-async-logic` instead.

**Input** — `-f`/`--folder`: the **app root** (one level above the FSM
plugin-root directory — e.g. `apps/fsm-core-example`, not
`apps/fsm-core-example/fsm`). `-l`/`--lang`: exactly one language, required.
`-v`/`--version`: version name matching `v\d{2}` (e.g. `v01`), required.
`-n`/`--name`: actor function name, required.

**Output**:

- `<appRoot>/shared-async-op/<version>/<lang>/actors/<name>/<name>.<ext>`
- That language's registry file, rewritten from every actor currently on disk
  under that folder (`typescript`/`python`/`rust` only — Go has no shared
  registry)

```bash
npx @pgfsm/compiler -c create-async-logic -f apps/fsm-core-example --lang typescript --version v01 --name checkCreditScore
```

### `delete` — remove generated files

**Input** — `-f`/`--folder`: plugin-root directory. `-s`/`--skip-dirs`.

**Output/side effect** — per version folder, removes `fsm.json`,
`xstate-fsm.json`, and the `typescript/` and `python/` subdirectories if present
(`rust/`/`go/` are left alone). Missing files are skipped silently, not an
error.

```bash
npx @pgfsm/compiler -c delete -f fsm
```

### `validate-sync-operation` — check action/guard/delay stubs are implemented

**Input** — `-f`/`--folder`: plugin-root directory. `-s`/`--skip-dirs`.

**Output** — writes nothing; validates that every action/guard/delay in
`fsm.json` has a matching export in `<lang>/actions|guards|delays/index.*` and
logs a pass/fail result per method.

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

`generateAsyncOperationLogicFromFolders`'s 4th parameter, `writeRootAbsPath`, is
required — a pure write destination for the aggregate registry/worker SDK (see
the CLI section above for what it does and doesn't control). The CLI itself has
no dedicated flag for it: it passes `--folder`'s own value in directory mode, or
`--output`'s in single-file mode.

The REST API and workers use these at startup to discover and validate FSM
plugins before accepting requests.

## License

Apache-2.0
