# CLAUDE.md — Dev Stack Orchestrator (`packages/fsm-devstack-ts/`)

Scoped guidance for `@pgfsm/devstack`. Repo-wide conventions and session
protocol live in the root `CLAUDE.md` / `AGENTS.md`. `README.md` is the
npm/npx-consumer-facing document (published to `dist/` — see below); keep
source-only detail here instead of there. Its scope is narrower than this
file's: it only documents the currently-publishable library export
(`runSupervised`/`runProcessGroup`), not `fsmdev` itself (see below).

## What it is

`fsmdev` (`src/cli/fsmdev.ts`), a one-command local dev-stack launcher (issue
#238). Sequence:

1. `generate-all` — one-shot, must succeed first. Calls `@pgfsm/compiler`'s
   `generateFsmJSONFromFolders` / `generateAsyncOperationLogicFromFolders` /
   `generateSyncOperationLogicFromFolders` directly, in-process, replicating
   fsm-compiler-ts's own CLI's folder-mode `generate-all` sequence exactly
   (including its per-step error aggregation).
2. Prints the exact start command for every worker-SDK language `generate-all`
   actually generated (typescript/python/rust/go — whichever subdirectories
   exist under `<app-root>/worker-sdk-generated/`). `fsmdev` does **not** launch
   these itself: they're polyglot, per-project generated code with different
   toolchains (`deno run`, `python3`, `cargo run`, `go run`), so starting them
   is left to the user, one terminal each.
3. `pgcron` registration — one-shot, idempotent. Calls
   `registerScheduleAllPendingCronJob` from `@pgfsm/db` directly, in-process
   (the same function `@pgfsm/sync-worker`'s `pgcron` CLI calls).
4. The Activity Gateway (`@pgfsm/async-worker`'s
   `async-operation-worker-gateway` bin) and `fsmlet` (`@pgfsm/sync-worker`'s
   `fsmlet` bin) — each spawned as that sibling package's own real CLI, each its
   own subprocess, supervised together via `runSupervised`. `Ctrl+C` stops both;
   if either exits on its own the other is torn down (see failure policy below).

**Library imports for one-shot steps; real sibling CLIs for long-running ones
(#251).** generate-all/pgcron are one-shot, so fsmdev just calls
`@pgfsm/compiler`/`@pgfsm/db`'s functions directly — no subprocess at all. The
gateway and fsmlet are long-running and need real process isolation (so one
crashing doesn't take fsmdev down with it, and so `runSupervised`'s fail-fast
policy has something to supervise), so `fsmdev` spawns `@pgfsm/async-worker`'s
and `@pgfsm/sync-worker`'s **own real CLIs** — `async-operation-worker-gateway`
and `fsmlet` — as separate processes, by name, and lets `PATH` resolve them.

An earlier revision (#245) instead shipped two small self-owned wrapper files
(`src/cli/run-gateway.ts`/`run-fsmlet.ts`) that imported
`startActivityGatewayServer`/`runFsmlet` directly and re-exposed a scoped-down
CLI, because `@pgfsm/sync-worker`/`@pgfsm/async-worker` weren't published to npm
yet — a wrapper bin `fsmdev` registered itself could still land on `PATH`
regardless of the sibling packages' own publish status. Once both were published
with correct `dependencies` of their own (#283/#286–#289), #251 removed the
wrappers: `fsmdev.ts`'s `toProcessSpec` now spawns the sibling packages' own CLI
**source files** directly under Deno (path computed relative to `fsmdev.ts` via
`import.meta.url`, reaching into `../fsm-sync-worker-ts/src/cli/fsmlet.ts` /
`../fsm-core-async-op-worker/src/cli/async-operation-worker-gateway.ts` — this
only has to resolve inside this monorepo checkout, since the Deno branch never
runs from an installed package) or their **real published bin names** under the
dnt-built Node output:

```ts
const isDeno = typeof process !== "undefined" && !!process.versions?.deno;
// under Deno: cmd = Deno.execPath(), args = ["run", "--allow-all", <sibling CLI path>.ts, ...]
// under Node: cmd = "fsmlet" / "async-operation-worker-gateway" (bare name, resolved via PATH), args = [...]
```

`@pgfsm/sync-worker`/`@pgfsm/async-worker` are declared as real `dependencies`
in `scripts/build-npm.ts` (see "Real dependencies" below) purely so
`npm install`ing `@pgfsm/devstack` links their `fsmlet`/
`async-operation-worker-gateway` bins into `node_modules/.bin` alongside
`fsmdev`'s own — the same mechanism `npx -p @pgfsm/sync-worker -- fsmlet`
already relies on for that package's own bin, verified previously (#245) by
building this package, installing its `dist/` output into a scratch project as a
dependency, and confirming the wrapper bins of that era all appeared in
`node_modules/.bin` correctly. (Running `npm install` _inside_ a package's own
directory does **not** self-link that package's own bins; only a dependency's
bins get linked that way — don't be misled by testing it that way.) The real
sibling CLIs' flag surfaces are supersets of what the old wrappers exposed
(`fsmlet` also supports single-`fsm.json` mode via `--fsm-name`/`--fsm-version`;
`async-operation-worker-gateway` also supports
`--disable-poll-loop`/`--invoke-timeout-ms`) — `fsmdev` still only passes the
subset it always did, so behavior is unchanged even though the full surface is
now reachable.

None of this repo's other CLIs spawn or supervise child processes, so
`src/supervisor.ts` (issue #239) is the first such primitive here.

Two things had to be verified empirically before `isDeno`-based dispatch was
safe to write at all (see git history for the throwaway probes, not kept in the
tree):

- **`typeof Deno !== "undefined"` cannot be used to detect the runtime.** dnt's
  `shims: { deno: true }` always defines a global `Deno` polyfill in the
  compiled Node output, so that check is `true` under _both_ runtimes.
  `process.versions.deno` is the reliable signal instead — it only exists under
  real Deno, in either build.
- **`Deno.execPath()` under that polyfill resolves to a real system `deno`
  binary path**, not this process's own — using it to decide how to spawn things
  under the Node build would silently require Deno to be installed anyway,
  defeating the point. Hence branching on `isDeno` rather than trying to make
  one code path serve both (unlike `supervisor.ts`, where
  `node:child_process`/`node:process` genuinely do work identically under both
  runtimes with no branching needed at all).

Every other `Deno.*` call in `fsmdev.ts` (`Deno.args`, `Deno.exit`,
`Deno.env.get`, `Deno.stat`, `Deno.readDirSync`, `Deno.addSignalListener`)
needed **no changes** — dnt's shim already implements all of them faithfully
(verified empirically against the actual compiled+`node`-executed output);
`Deno.Command` remains the one Deno API with no shim at all (per
`@deno/shim-deno`'s own progress tracking), which is exactly why `supervisor.ts`
moved off it in #244 and why `fsmdev`'s own spawn calls need the `isDeno` branch
above instead of a shimmed call. `fsmdev` keeps the same top-level `await` style
as every other CLI in this repo — no `async function main()` wrapper needed; dnt
only refuses top-level `await` for a _plain_ entry's CJS/UMD output, not a
bin's, and `fsmdev` is registered as a `bin`.

**The `deno task build:npm` → `npx -p @pgfsm/devstack -- fsmdev` path works end
to end, verified — with one real remaining gap (below).** `@pgfsm/compiler` and
`@pgfsm/db` are now real `dependencies` (mapped via `dnt`'s `mappings` option —
see "Real dependencies" below); `@pgfsm/sync-worker`/ `@pgfsm/async-worker` are
real `dependencies` too, declared directly since nothing imports their bare
specifier anymore. Verified: `deno task build:npm` completes,
`dist/package.json`'s `dependencies` lists all four (not vendored source),
`node dist/esm/fsm-devstack-ts/src/cli/fsmdev.js --help` runs correctly under
Node.

**Real remaining gap: `generate-all` doesn't work under Node at all, for a
reason that has nothing to do with dispatch.** `@pgfsm/compiler`'s
`generateFsmJSONFromFolders` dynamically `import()`s the user's raw `machine.ts`
file in-process — Deno can do this natively (built-in TS transpilation on
`import()`); Node cannot, with no TS loader anywhere in this dependency chain.
Verified directly: running `fsmdev`'s compiled Node bin against a real FSM
project fails immediately with `Failed to import
.../machine.ts` for every
single FSM, `generateFsmJSONFromFolders`'s own `AggregateError` aggregating one
failure per FSM version folder. This is a pre-existing gap in `@pgfsm/compiler`
itself, not something `fsmdev`'s dispatch design can route around — it would
affect `@pgfsm/compiler`'s own published `fsm-compiler` bin identically, for any
real project, once published. Not filed as its own issue yet.

**Found and fixed along the way**: wiring `run-fsmlet.ts` to import
`@pgfsm/sync-worker`'s `runFsmlet` directly (rather than spawning its CLI) made
`deno check` walk into that package's module graph for the first time from here,
surfacing pre-existing bug **#169** — `fsmlet.ts`'s
`asyncOperationVerificationMode: "checkRegistry"`/ `"checkRegistryAndWorking"`
paths passed `ActorReference[]` (no `fsmVersion` field at all) into
`checkRegistryForAsyncActors`/ `checkRegistryAndWorkingForAsyncActors`, which
expect `AsyncActor[]` (`{ src, fsmVersion }`) and read that `fsmVersion` key to
match against each actor's own `async_operation_version` in Postgres (despite
the confusing name — the parent FSM's version is already a separate argument to
both SQL functions). With the field always undefined, both checks always
reported every actor as unregistered. Fixed in
`fsm-sync-worker-ts/src/fsmlet/fsmlet.ts` by mapping
`ActorReference.asyncOperationVersion` → `AsyncActor.fsmVersion` at the two call
sites (`toAsyncActors` helper) — see that package's own history for the fix,
this note is just about how it surfaced.

## Process supervision (`src/supervisor.ts`)

- `runSupervised(specs, options?)` — spawns every `ProcessSpec`, forwards
  `SIGINT`/`SIGTERM` to all children, and resolves with the exit code the CLI
  should pass to `Deno.exit`/`process.exit`.
- `runProcessGroup(specs, shutdownSignal)` — the core race logic, decoupled from
  real OS signals via an injected `Promise<SupervisorSignal>` so tests can drive
  shutdown without sending signals to the test process itself.
- **Failure policy (decided on #239):** if any child exits on its own before
  shutdown was requested, the supervisor tears down all remaining children and
  exits non-zero (fail-fast) — a dead gateway/fsmlet/pgcron process usually
  makes the rest of the stack non-functional anyway, so continuing risks a
  silent partial-stack state.
- **Cross-runtime by construction, not by branching (#244):** built on
  `node:child_process`'s `spawn` and `node:process`'s `process.on`/`.off` for
  signal delivery instead of `Deno.Command`/`Deno.addSignalListener` — both work
  natively under Deno (via its Node-compat layer, verified empirically:
  spawn/exit-code/exit-signal and real `SIGTERM` delivery to a `process.on`
  handler all behave correctly) _and_ under real Node, so no runtime detection
  is needed. This is the piece that makes a `dist/esm`/`dist/script` dnt build
  of this package's library export (`deno task build:npm`) actually work when
  loaded by plain `node` — verified by running the built output's
  `runProcessGroup` against real Node child processes and getting identical
  results to the `deno test` suite. `fsmdev.ts`/`run-gateway.ts`/
  `run-fsmlet.ts` need their own `isDeno` branch instead of a shared code path
  (see above) — the thing they need branched on (how to invoke another script)
  has no cross-runtime-identical primitive the way spawning/signaling a child
  process does.

## Structure (`src/`)

- `supervisor.ts` — spawn/signal/failure-policy primitive
- `supervisor.test.ts` — covers early-exit teardown,
  clean-exit-is-still-a-failure, requested-shutdown, and empty-spec-list
  rejection
- `index.ts` — barrel export
- `cli/fsmdev.ts` — the orchestrator CLI, the only `bin` entry (see above)

`scripts/build-npm.ts` builds `index.ts` (library export) and `fsmdev.ts` (the
one `bin` entry — see "What it is" above for why `run-gateway.ts`/
`run-fsmlet.ts` no longer exist). See "Real dependencies" below for how it
declares `@pgfsm/compiler`/`@pgfsm/db`/`@pgfsm/sync-worker`/
`@pgfsm/async-worker`. Sets `test: false` in the dnt `build()` options because
this package, unlike the sibling dnt-built packages, colocates
`supervisor.test.ts` under `src/`; without that, dnt also transforms/type-checks
it as a Node test file and pulls in `@std/assert`, which needs a newer `lib`
target than this package's `compilerOptions` sets. `postBuild()` only copies
`README.md` into `dist/` when `--copy-readme` is passed
(`deno task build:npm <version> --copy-readme`, as CI does) — a plain local
`deno task build:npm` skips it, same convention as the sibling packages.

## Real dependencies

`@pgfsm/compiler`, `@pgfsm/db`, `@pgfsm/sync-worker`, and `@pgfsm/async-worker`
are all real npm `dependencies` in `scripts/build-npm.ts` now (#251) — but via
two different mechanisms, because they relate to this package's compiled code in
two different ways:

- **`@pgfsm/compiler`/`@pgfsm/db`** are genuinely imported as bare specifiers in
  `fsmdev.ts`'s own compiled code (`generate-all`/`pgcron` call their library
  functions directly, in-process). Mapped via `dnt`'s `mappings` option, same
  pattern as `fsm-sync-worker-ts`'s build (#283/#289) — this redirects the
  import to the real npm package instead of letting `dnt` vendor the
  workspace-resolved source, and declares the dependency. Version read from each
  package's own `deno.json` at build time, not hardcoded.
- **`@pgfsm/sync-worker`/`@pgfsm/async-worker`** are **not** imported by any
  compiled code here anymore — `fsmdev` only spawns their `fsmlet`/
  `async-operation-worker-gateway` bins as separate OS processes (see "What it
  is" above). There's no bare specifier for `mappings` to redirect, so these are
  a plain `package.dependencies` entry instead, declared purely so
  `npm install`ing `@pgfsm/devstack` links those bins into `node_modules/.bin`
  alongside `fsmdev`'s own.

`@pgfsm/logging` stays vendored — it isn't in
`.github/workflows/npm-publish.yml`'s matrix, so there's no real package to map
it to.

Before #251, none of the four were declared at all: `@pgfsm/sync-worker`/
`@pgfsm/async-worker` were reached only through the now-removed
`run-gateway.ts`/`run-fsmlet.ts` wrapper bins (see "What it is" above for why
those existed and how they were retired), and `@pgfsm/compiler`/`@pgfsm/db` were
still vendored via `dnt`'s default handling of the Deno workspace-linked import
— the same shape PR #248 (closing #247) documented for `@pgfsm/db` inside
`fsm-sync-worker-ts`'s and `fsm-core-async-op-worker`'s own builds, one layer
deeper (a fix to any of these four needed **two** republish steps to reach a
`@pgfsm/devstack` install: the vendored package itself, then this package). All
four are now real npm packages with correct `dependencies` of their own (#283,
#286–#289), so mapping instead of vendoring is safe here the same way it was for
them.

## Commands

```bash
deno task fsmdev    # deno run --allow-all src/cli/fsmdev.ts
deno task test      # deno test --allow-all src/
deno task check     # deno check src/index.ts src/cli/fsmdev.ts
deno task build:npm # scripts/build-npm.ts (dnt npm build — succeeds; generate-all still fails under the built Node output, see above)
```
