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

## `generate-async-logic` — the aggregate write destination has no dedicated flag

There is no separate CLI input for where `worker-sdk-generated/` gets written
(`<writeRootAbsPath>/worker-sdk-generated/<lang>/`) — the CLI derives it: in
directory mode it's one level above `--folder` (the app root — matching the
`apps/fsm-core-example/` convention, where `worker-sdk-generated/` sits beside
`fsm/`, not inside it); in single-`fsm.json` mode it's `--output`. It is never
re-walked to find actors and doesn't need to contain any FSM itself. (An earlier
revision exposed this as its own required `-g`/`--plugin-root` flag, decoupled
from `--folder`/`--output` entirely — that flag was removed as an unnecessary
extra input once every caller had a good default; the internal
`writeRootAbsPath` parameter documented below still exists and library callers
can still point it anywhere.) See `README.md`/`docs/guides/cli-usage.md` for the
user-facing explanation; the gotchas below are for whoever next touches
`generate-async-operation-logic.ts`/`operation-logic-scaffold.ts`:

- **Three distinct roots, don't conflate them**: `writeRootAbsPath` (where files
  land — arbitrary), `realPluginRootAbsPath` (the actual FSM tree — `--folder`
  itself in directory mode, or derived from the target `fsm.json`'s own location
  three levels up in single-file mode), and `goModuleAppRoot` (the real app-root
  directory name, e.g. `"fsm-core-example"`, that each individual Go actor's own
  `go.mod` already names itself under — see `goActorModulePath`). Only
  `realPluginRootAbsPath` is walked for actors; only `goModuleAppRoot` feeds Go
  module names. Passing `writeRootAbsPath` where one of the other two belongs
  breaks either the aggregate (wrong/empty actor set) or Go module resolution
  silently.
- **Every cross-directory reference is a real computed `relative()`** (from
  `@std/path/posix`, via `operation-logic-scaffold.ts`'s `relativeImportDir`
  helper) between the write location and `realPluginRootAbsPath` — TS/Rust
  imports, Python's `sys.path` bootstrap, both Go `replace` targets, and the
  `gatewaySidecarProtoGen*`/`gatewaySidecarProtocolImportPath` helpers (proto-
  codegen paths, which still assume `realPluginRootAbsPath` sits at the
  conventional `<repo-root>/apps/<appName>/<pluginRootDirName>` depth — true for
  `apps/fsm-core-example/fsm`, this codegen's only consumer so far; a
  `realPluginRootAbsPath` elsewhere needs those recomputed). None of this is a
  fixed `../../` string anymore — if you're debugging a wrong import path in
  generated output, check `relativeImportDir`'s two arguments first.
- **`deno.json` gained `@std/path`** for the above; nothing else in this package
  needed it before.

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
