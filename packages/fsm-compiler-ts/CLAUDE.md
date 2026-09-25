# CLAUDE.md — FSM Compiler (`packages/fsm-compiler-ts/`)

Scoped guidance for the JSON → database object compiler. Repo-wide conventions
and session protocol live in the root `CLAUDE.md` / `AGENTS.md`.

## Commands

```bash
deno task dev             # watch mode — src/cli/index.ts
deno task cli             # one-shot run — src/cli/index.ts
deno task test            # deno test --allow-all test/
deno task build:npm       # scripts/build-npm.ts (dnt npm build)
```

`src/types/index.ts` is this package's one types entry point. It holds every
hand-written type definition (`WorkflowType`, `ActorReference`,
`RegisteredActor`, `FsmDraftStateNode`, etc.) — not colocated with the functions
that use them — and also re-exports, by name (not a blanket `export type *`),
only the schema-derived types this package actually imports somewhere
(`FsmMachineJson`, `ActionObject`, `AtomicStateNode`, `CompoundStateNode`,
`FinalStateNode`, `HistoryStateNode`, `ParallelStateNode` as of this writing —
grep the package for the full current list). Those types actually live in
`packages/database-src/generated/fsm-machine-schema.types.ts` (regenerated from
`packages/database-src/`, not here — see that package's `CLAUDE.md` for
`generate:fsm-types`). When a file needs a schema type not yet in that list, add
it there rather than importing `database-src` directly — every other source file
imports both kinds of types from `./types/index.ts` (or `../types/index.ts` from
`src/cli/` and `src/scaffold-templates/`). Only genuinely file-private helper
types (unexported, single-use, e.g. `util.ts`'s `DenoCommandCtor`) stay where
they're defined.

Deno version is managed by `.prototools`: `proto install deno --pin local`.

## What it does

Compiles `fsm.json` definitions into the PostgreSQL objects that drive
instances. See `apps/fsm-core-example/CLAUDE.md` for the source FSM definition
format this compiler consumes. `README.md` is the npm/npx-consumer-facing
document (published to `dist/` — see below); keep source-only detail here
instead of there.

## `generate-sync-logic`/`generate-async-logic` write to `Deno.cwd()`, not `--folder`/`--output` (#305, #307)

Both commands are anchored entirely at wherever the CLI is invoked from,
independent of `--folder`'s own location: `generate-sync-logic` at
`{cwd}/sync-worker/<lang>/<fsmName>/<fsmVersion>/`, `generate-async-logic` at
`{cwd}/async-worker/<lang>/<fsmName>/<fsmVersion>/actors/...` (plus the
aggregate registry/worker SDK at `{cwd}/async-worker/<lang>/` directly). Neither
command accepts `--output` any more — single-fsm.json mode instead requires
`-N`/`--fsm-name` and `-V`/`--fsm-version` explicitly (mirroring
`validate-sync-operation`'s own single-file-mode flags), since there's no
`<fsmName>/<fsmVersion>/fsm.json` folder structure to infer identity from and no
version folder to accept as `--output` in the first place. Folder mode derives
`<fsmName>/<fsmVersion>` per FSM while walking the plugin-root tree, same as
before.

`generate-all` is the one exception: its own async-/sync-logic steps still write
under its existing `writeRootAbsPath` convention (the app root — one level above
`--folder` — in folder mode; `--output`'s own value in either single-file mode),
nested `<sync|async>-worker/<lang>/<fsmName>/<fsmVersion>/` deep rather than
directly into it. `fsmName`/`fsmVersion` are derived from `--output`'s own path
the same way `generateAsyncOperationLogicFromFsmJson`'s `realPluginRootAbsPath`
derivation already did — see `generate-all.ts`.

The gotchas below are for whoever next touches
`generate-async-operation-logic.ts`/`operation-logic-scaffold.ts`:

- **`writeRootAbsPath` is now also the actor write root, not just the
  aggregate's.** Before #307, actor files lived inside each FSM's own version
  folder (colocated with `fsm.json`) and only the aggregate registry/worker SDK
  had a separate `writeRootAbsPath`. Now both live under the same
  `<writeRootAbsPath>/async-worker/<lang>/` tree — per-version actors nested
  `<fsmName>/<fsmVersion>/` deep, the aggregate directly in `<lang>/`. This is
  what made the aggregate's own relative-import computation trivial (see below).
- **`realPluginRootAbsPath` narrowed to one job: deriving `goModuleAppRoot` and
  `writeWorkerSdk`'s `repoRootAbsPath`.** It's the real FSM source tree —
  `--folder` itself in directory mode, or derived from the target `fsm.json`'s
  own location three levels up in single-file mode — used only for (a) the real
  app-root directory name (`"fsm-core-example"`) each Go actor's own `go.mod`
  names itself under, and (b) `writeWorkerSdk`'s
  `gatewaySidecarProtoGen*`/`gatewaySidecarProtocolImportPath` targets, which
  point at sibling monorepo packages relative to where the _source_ tree sits, a
  relationship independent of where output gets written. It is **not** used
  anymore to locate per-version actor files or registries — those are always
  reachable from `writeRootAbsPath` alone now.
- **The aggregate's relative-import computation is trivial by construction
  now.** `writeAggregateActorsRegistry`/`buildAggregateRegistryContent` no
  longer take a `realPluginRootAbsPath` param at all — since every
  `<fsmName>/<fsmVersion>/` group this run wrote lives directly inside the
  aggregate's own directory (`<writeRootAbsPath>/async-worker/<lang>/`), the
  relative import is always `./<fsmName>/<fsmVersion>` (TS/Rust) or `.`
  (Python's `sys.path` bootstrap) — no longer a real cross-tree `relative()`
  computation via `relativeImportDir`. Same for `writeAggregateGoRegistry`'s Go
  actor `replace` targets, computed from `writeRootAbsPath` instead of
  `realPluginRootAbsPath` — each actor's own `go.mod` now physically lives at
  `<writeRootAbsPath>/async-worker/go/<fsmName>/<fsmVersion>/actors/<fileBaseName>/`.
- **`writeActorFile`/`writeActorsBarrel`/`writeActorsRegistry` gained an
  optional `subPath` param** (mirroring `writeOperationModule`'s own, added in
  #305) — `generate-async-operation-logic.ts` passes `<fsmName>/<fsmVersion>`
  there to avoid multiple FSMs/versions writing under the same `<lang>` root
  colliding. `create-async-logic.ts`'s shared-async-op pool passes
  `shared-async-op/<functionVersion>` there too (as of #309, mirroring
  `<fsmName>/<fsmVersion>`) — see "`create-async-logic` writes under
  `async-worker/`" below for its own extra nesting need.
  `writeActorFile`/`writeActorsBarrel` insert `subPath` between `<lang>` and
  `actors/`; `writeActorsRegistry` inserts it between `<lang>` and the registry
  file itself, one level _above_ `actors/` (#328 — see its own doc comment for
  why it moved out of `actors/`, where it originally lived colocated with the
  barrel).
- **`actors-manifest.json` is now per-language, not one combined manifest.**
  Written once per `<fsmName>/<fsmVersion>` **per language actually used** (not
  every `SUPPORTED_OPERATION_LANGS` member) at
  `<writeRootAbsPath>/async-worker/<lang>/<fsmName>/<fsmVersion>/actors-manifest.json`
  — an empty manifest for a language a given FSM doesn't use would just be
  directory clutter now that it's no longer colocated with every other
  language's own output.
- **`actors-manifest.json` carries the full activity-registration identity, not
  just the write-time subset** (#320) — `writeActorsManifest` takes
  `RegisteredActor[]`, not `WrittenActor[]`, and serializes every field
  (`parentFsmName`/`parentFsmVersion`/`src`/`asyncOperationName`/
  `asyncOperationType`/`asyncOperationVersion`/`asyncOperationLanguage`/
  `filePath`), the same identity the aggregate registries already emit, so a
  consumer doesn't need to cross-reference the parent `fsm.json`.
  `RegisteredActor.exportedName` is serialized under the manifest's own
  `exportedAsyncOperationName` key — the in-memory field name is unchanged, this
  is a manifest-output-only rename.
- **`writeWorkerSdk` writes a TypeScript-only `deno.json` alongside `cli.ts`/
  `sdk.ts`** (`<writeRootAbsPath>/async-worker/typescript/deno.json`, #318) —
  scoped to that one language subdirectory, matching Python's
  `requirements.txt`/Rust's `Cargo.toml`/Go's `go.mod`, all written by this same
  function for their own language. Two Eta variants
  (`worker-sdk-deno-json.eta`/`worker-sdk-deno-json-legacy.eta`), selected by
  `options.protocol` same as every other protocol-conditional pair here —
  `legacy` drops `@connectrpc/connect`/`@connectrpc/connect-node` since
  `sdk-legacy.eta` doesn't import them. Runs for both {@linkcode
  generateAsyncOperationLogicFromFolders} and {@linkcode
  generateAsyncOperationLogicFromFsmJson} (both share `writeAggregateArtifacts`
  → `writeWorkerSdk`), so it's kept in sync on every regeneration regardless of
  which CLI mode wrote it.
- **`WrittenActor.filePath` dropped its `<lang>/` prefix** (now
  `actors/<fileBaseName>/<fileBaseName>.<ext>`, not
  `<lang>/actors/<fileBaseName>/<fileBaseName>.<ext>`) — it's informational
  manifest/log content only (never used to construct an actual import path;
  barrels/registries use `fileBaseName` directly with their own relative `./`
  prefix), and since the manifest is now itself already lang-scoped, the prefix
  was redundant.
- **`ASYNC_WORKER_DIR_NAME`** (`operation-logic-scaffold.ts`, exported) is
  `"async-worker"` — renamed and repurposed from the pre-#307
  `WORKER_SDK_DIR_NAME` (`"worker-sdk-generated"`), which sat one level above
  `--folder` and held only the aggregate. `generate-sync-operation-logic.ts` has
  its own equivalent `SYNC_WORKER_DIR_NAME` = `"sync-worker"` (not exported from
  `operation-logic-scaffold.ts`, since `writeSyncOperationRegistry` receives the
  full path already-composed by its caller rather than composing it itself the
  way the async aggregate writers do).

## `create-async-logic` writes under `async-worker/`, with its own global registry (#309, #311, #322, #324)

Rewritten in #309 to match the #307 async-worker/ model: `-n`/`--function-name`
and `-F`/`--function-version` (dedicated flags — no `--fsm-name`, and
`--fsm-version`/`--name` were retired for this command) replace the old
`--name`/`--fsm-version`, and output moved from
`<appRoot>/shared-async-op/<version>/<lang>/actors/<name>/<name>.<ext>` to
`<appRoot>/async-worker/<lang>/shared-async-op/<functionVersion>/actors/<functionName>/<functionVersion>/<functionName>.<ext>`
— `<functionVersion>` appeared **twice**: once as the top-level partition
(`writeActorFile`'s `subPath`, `shared-async-op/<functionVersion>`, mirroring
`<fsmName>/<fsmVersion>`) and once more nested under the actor's own name folder
(`writeActorFile`'s now-removed `fileSubPath` param). #322 dropped that second
nesting level — it had no FSM-scoped equivalent and existed only because the
user who requested #309 asked for it explicitly; a later request (#322) asked
for it removed. Current layout:
`<appRoot>/async-worker/<lang>/shared-async-op/<functionVersion>/actors/<functionName>/<functionName>.<ext>`
— `writeActorFile`/`writeGoActorModule` no longer take a `fileSubPath` param at
all (nothing else in the codebase ever passed one).

#322 also added
`<appRoot>/async-worker/<lang>/shared-async-op/<functionVersion>/actors-manifest.json`
— written/rewritten on every `create-async-logic` call via
`rewriteSharedAsyncOpManifest`, same "rebuild from whatever's actually on disk"
approach as `rewriteSharedAsyncOpRegistry` below, but scoped to actors at _that
one_ `functionVersion` (unlike the registry's single global file across every
version), since the manifest lives inside the version folder itself — mirrors
`generate-async-logic`'s own per-`<fsmName>/<fsmVersion>` manifest (#320),
written for every language including Go (Go has no registry, but still gets a
manifest, same as `generate-async-logic`'s own per-language manifests).

#311 went one step further: `<appRoot>` above is no longer a passed-in
`--folder` at all — the command drops `--folder` entirely, following
`generate-sync-logic`/`generate-async-logic`'s own #305/#307 precedent.
`createAsyncOperationLogic` still takes a `writeRootAbsPath` parameter (kept for
testability, same reasoning as `generateSyncOperationLogicFromFolders`/
`generateAsyncOperationLogicFromFolders` — `Deno.cwd()` is called exactly once,
in `cli/index.ts`, and passed down; the library function itself never calls
`Deno.cwd()`), but the CLI now always passes `Deno.cwd()` for it, and no longer
requires or reads `--folder` for this command at all (excluded from both the
`missing`-args check and the generic `--folder` existence/type validation in
`cli/index.ts`).

Registry-wise, this command deliberately does **not** mirror
`generate-async-logic`'s per-`<fsmName>/<fsmVersion>` registries — since
shared-async-op actors have no owning FSM/version to partition by, there's a
single **global** file per language,
`<appRoot>/async-worker/<lang>/shared-async-op/generated-registry.<ext>`,
accumulating every `functionVersion`'s actors across repeated
`create-async-logic` calls (rebuilt from a fresh directory walk each time, same
idempotent-rebuild approach as before #309). This needed its own
`shared-async-op-registry.eta` template per language (typescript/python/rust) —
none of the existing registry templates fit, since they all assume the actor
being registered is a direct sibling of (or reachable through an already-written
per-group registry near) the file being written, and this one reaches into
multiple `<functionVersion>/actors/<functionName>/` subtrees from one fixed
location. Every import is aliased (`<functionName>_<functionVersion>`) since the
same function name can legitimately recur across different `functionVersion`s.
Deliberately never touches the FSM-scoped aggregate
(`<lang>-actors-registry.generated.ts`) — this pool stays fully separate from
it, same as before #309.

`listExistingSharedAsyncOpActors` (the shared "rebuild from what's on disk" walk
both the registry and the manifest use) verifies each actor's own stub file
actually exists (`${versionDir}/${toWrittenActor(lang, {src:
name}).filePath}`)
before including its `<name>/` directory — not just that the directory exists
(#324). Without this, hand-removing an actor's file + `actors-manifest.json` but
leaving the now-empty `<name>/` directory behind left a stale entry that the
_next_ `create-async-logic` call (for any `functionVersion`, not just the stale
one) would still pick up, rebuilding a registry that imports a handler from a
file that no longer exists.

#324 also added Go's own aggregate,
`<appRoot>/async-worker/go/shared-async-op/go-actors-registry-generated/`
(`go.mod` + `registry.go`) — before this, `--lang go` wrote the actor file and
its own standalone `go.mod` but nothing stitched Go shared-async-op actors
together the way TS/Python/Rust's `generated-registry.*` does, so they had no
generated way to be imported/dispatched as a group.
`rewriteSharedAsyncOpGoRegistry` (create-async-logic.ts) mirrors
`writeAggregateGoRegistry`'s FSM-scoped approach (one `require`+`replace` per
actor's own module) but is a **separate function**, not a call into
`writeAggregateGoRegistry` — that function derives each actor's on-disk `go.mod`
directory from `<parentFsmName>/<parentFsmVersion>` directly, correct for the
FSM-scoped pool where `parentFsmName` _is_ the real directory name, but
shared-async-op actors' `parentFsmName` is the fixed identity string
`"sharedAsyncOperation"` while their real on-disk directory is `shared-async-op`
(hyphenated) — reusing it verbatim would compute a `replace` target pointing at
a directory that doesn't exist.

## npm publish (`deno task build:npm`)

`scripts/build-npm.ts` builds the npm package via `@deno/dnt`, not `deno pack`
(used for this repo's other npm-published packages). `deno pack` does not
synthesize a `package.json` `bin` field — per the Deno docs' "Limitations"
section (https://docs.deno.com/runtime/reference/cli/pack/), it's
library-publishing only, so a CLI packed that way would be unreachable from
`npx`. dnt transpiles + Node-shims the source into `dist/`, registering both the
library export and the shebanged `fsm-compiler` CLI bin.
`.github/workflows/npm-publish.yml` builds this package's `compiler` matrix
entry through the dnt path for that reason.

`postBuild()` only copies `README.md` into `dist/` when `--copy-readme` is
passed (`deno task build:npm <version> --copy-readme`, as CI does) — a plain
local `deno task build:npm` skips it.

dnt's Deno shim doesn't implement `Deno.Command` (unchecked in
[shim-deno's PROGRESS.md](https://github.com/denoland/node_shims/blob/main/packages/shim-deno/PROGRESS.md)),
so anything that shells out to a language runtime — actor validation
(`validate-async-operation`) and the best-effort `deno fmt` pass on generated TS
stubs — is unavailable in the npm/npx build. See `src/util.ts`'s `DenoCommand`
export and its callers in `src/validate-async-operation-logic.ts` and
`src/operation-logic-scaffold.ts`.

### `Deno.remove`/`Deno.removeSync` don't throw `Deno.errors.NotFound` under the npm/npx build (#278)

`@deno/shim-deno`'s `stat`/`lstat`/`statSync`/`readTextFile`/`readDir` all
correctly map Node's raw `fs` errors into real `Deno.errors.*` instances via an
internal `errorMap` — but its `remove`/`removeSync` don't: a missing path
(without `{ recursive: true }`, which Node maps to
`{ recursive: true, force:
true }` and so never throws at all) rethrows the raw
Node `fs.rm`/`fs.rmSync` error unwrapped, a plain `Error` with
`.code === "ENOENT"`, never an instance of `Deno.errors.NotFound`. Any
`catch (error) { if (!(error instanceof
Deno.errors.NotFound)) throw error; }`
"ignore a missing path" pattern built on a non-recursive
`Deno.remove`/`Deno.removeSync` therefore silently breaks under Node. Use
`src/util.ts`'s `isNotFoundError(error)` instead of a bare `instanceof` check
anywhere this pattern shows up — it recognizes both real Deno's
`Deno.errors.NotFound` and the shim's unwrapped `ENOENT`.
`delete-fsm-json-from-folders.ts`'s two non-recursive removes are the current
consumer; `fsm-core-async-op-worker` has its own copy of the same helper for its
two socket-cleanup call sites (`gatewayServer.ts`'s `cleanupUnixSocket`,
`sidecar/gateway.ts`'s `cleanupSocket`) — see that package's own `CLAUDE.md`.

### Dynamic import of a target FSM file under the npm/npx build (#270)

`generateFsmJSONFromMachineFile` and `validateLanguageModules` dynamically
`import()` a user's own `machine.ts` / per-language
`actions|guards|delays/index.ts` directly off disk. Those files routinely
bare-import npm packages (e.g. `xstate`) that resolve only via the target FSM
tree's own Deno import map (`deno.json`'s `imports`) — under `deno run`, Deno's
module graph resolution honors that regardless of which file does the importing.
Under the npm/npx build (plain Node.js), Node resolves bare specifiers by
walking `node_modules/` upward **from the importing file's own path**, which
almost never has one near an FSM tree in this repo (they rely on the Deno import
map instead) — so this used to fail outright with `ERR_MODULE_NOT_FOUND`.

`src/import-resolution.ts` / `import-resolution.node.ts` (swapped via
`build-npm.ts`'s `mappings`, same pattern as `invocation.ts`/`version.ts`) and
`src/cli/loader.node.ts` fix this for the npm/npx build only: a Node
`node:module` `register()` resolve hook that, **only when Node's normal
resolution has already failed**, reads the failing specifier's nearest
`deno.json`(`c`) import map (walking up to the workspace root too, if any) and,
for an exact-key `npm:`-mapped entry, installs that package on demand into a
persistent per-user cache (`~/.cache/pgfsm-compiler/npm-import-map-deps` or
platform equivalent — `XDG_CACHE_HOME`/`~/Library/Caches`/`%LOCALAPPDATA%`)
before re-resolving. Needs network access + `npm` on `PATH` the first time a
given package is needed; cached thereafter. Deliberately scoped: only exact
`imports` keys (no `scopes`/trailing-slash prefix entries) and only `npm:`
values (not `jsr:`) — anything outside that, or any failure in the fallback
itself, rethrows the _original_ Node resolution error unchanged rather than
masking it. `loader.node.ts` must be listed explicitly in `build-npm.ts`'s
`entryPoints` — nothing statically imports it (it's only referenced by the
runtime string `register()` is called with), so dnt's graph walker won't find it
otherwise. `findMergedImportMap` (the import-map walk/merge algorithm) is plain
`node:fs`/`node:path` code with no Deno APIs, so it's directly `deno test`-able
even though the file only ever runs under Node — see
`test/import-resolution.test.ts`.

`src/types/index.ts`'s cross-package `import type`/`export type` reaching into
`../../../database-src/generated/` (see above) is type-only, so it never appears
in the emitted JS — but dnt's build still resolves and copies the source
`.ts`/emits a `.d.ts` for it into `dist/{esm,script}/database-src/generated/`,
self-contained inside the published package. Verified working as of this note;
if the build ever fails type-checking that file, that's the first place to look.
