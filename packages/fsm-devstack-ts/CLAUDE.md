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
4. The Activity Gateway and `fsmlet` — each its own subprocess, supervised
   together via `runSupervised`. `Ctrl+C` stops both; if either exits on its own
   the other is torn down (see failure policy below).

**Library imports over CLI dispatch (#245's original ask), with a twist for
long-running steps.** generate-all/pgcron are one-shot, so fsmdev just calls
`@pgfsm/compiler`/`@pgfsm/db`'s functions directly — no subprocess at all. The
gateway and fsmlet are long-running and need real process isolation (so one
crashing doesn't take fsmdev down with it, and so `runSupervised`'s fail-fast
policy has something to supervise), so instead of spawning
`@pgfsm/async-worker`/`@pgfsm/sync-worker`'s own CLI files, `fsmdev` spawns two
small **self-owned runner files it ships itself** — `src/cli/run-gateway.ts`
(imports `startActivityGatewayServer` from `@pgfsm/async-worker`) and
`src/cli/run-fsmlet.ts` (imports `runFsmlet` from `@pgfsm/sync-worker`), each
wiring its own `SIGINT`/`SIGTERM` to an `AbortSignal` those functions accept.
`fsmdev.ts` resolves these via `import.meta.url` relative to _itself_
(`./run-gateway.ts`, `./run-fsmlet.ts`) — which resolves correctly whether
`@pgfsm/devstack` lives in this monorepo or is installed via npm, unlike a path
reaching into a sibling top-level package's own CLI file.

None of this repo's other CLIs spawn or supervise child processes, so
`src/supervisor.ts` (issue #239) is the first such primitive here.

**`fsmdev` is now cross-runtime end to end (#245), via bin dispatch — not by
resolving a compiled sibling path.** `fsmdev.ts`, `run-gateway.ts`, and
`run-fsmlet.ts` are all registered as this package's own `bin` entries in
`scripts/build-npm.ts` — the same pattern `@pgfsm/sync-worker` uses for
`fsmlet`/`fsmscheduler`/`fsmctl`/`pgcron` and `@pgfsm/async-worker` uses for
`async-operation-worker-gateway`/`-ctl`. Under Node, `fsmdev` spawns
`run-gateway`/`run-fsmlet` **by their registered bin name**
(`pgfsm-devstack-run-gateway`/`pgfsm-devstack-run-fsmlet`) and relies on `PATH`
to resolve them:

```ts
const isDeno = typeof process !== "undefined" && !!process.versions?.deno;
// under Deno: cmd = Deno.execPath(), args = ["run", "--allow-all", <path>.ts, ...]
// under Node: cmd = "pgfsm-devstack-run-gateway" (bare name, resolved via PATH), args = [...]
```

An earlier revision instead resolved `run-gateway.js`/`run-fsmlet.js`'s
_compiled path_ directly (`isDeno ? "./run-gateway.ts" : "./run-gateway.js"`,
invoked with `process.execPath`), avoiding extra public bins at the cost of
coupling `fsmdev` to dnt's exact `dist/` layout. That approach was replaced with
bin dispatch — more robust (PATH resolution is a stable npm contract; dnt's
output directory shape isn't) and consistent with every other CLI in this repo —
after confirming empirically that it actually works: `npm
install`ing a package
**as a dependency of another project** (exactly what
`npx -p @pgfsm/devstack -- fsmdev` does) links _all_ of that package's own
declared bins into `node_modules/.bin` together, not just the one directly
invoked — verified by building this package, installing its `dist/` output into
a scratch project as a dependency, and confirming `fsmdev`,
`pgfsm-devstack-run-gateway`, and `pgfsm-devstack-run-fsmlet` all appeared in
`node_modules/.bin` and `node node_modules/.bin/fsmdev --help` ran correctly.
(Running `npm install` _inside_ a package's own directory — which is what a
naive local test does — does **not** self-link that package's own bins; only a
dependency's bins get linked that way. Don't be misled by testing it that way,
as an earlier pass in this session was.)

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

Every other `Deno.*` call in these three files (`Deno.args`, `Deno.exit`,
`Deno.env.get`, `Deno.stat`, `Deno.readDirSync`, `Deno.addSignalListener`)
needed **no changes** — dnt's shim already implements all of them faithfully
(verified empirically against the actual compiled+`node`-executed output);
`Deno.Command` remains the one Deno API with no shim at all (per
`@deno/shim-deno`'s own progress tracking), which is exactly why `supervisor.ts`
moved off it in #244 and why `fsmdev`'s own spawn calls need the `isDeno` branch
above instead of a shimmed call. Because all three are `bin` entries (not the
plain entries an earlier revision used), they keep the same top-level `await`
style as every other CLI in this repo — no `async function main()` wrapper
needed; dnt only refuses top-level `await` for a _plain_ entry's CJS/UMD output,
not a bin's.

**The `deno task build:npm` → `npx -p @pgfsm/devstack -- fsmdev` path now
actually works, end to end, verified — with one real remaining gap (below).** An
earlier pass in this session believed the build couldn't succeed because
`@pgfsm/compiler`/`@pgfsm/async-worker`/`@pgfsm/sync-worker` aren't published to
npm yet — that was wrong, self-inflicted by declaring them as npm `dependencies`
in `scripts/build-npm.ts` (see "Vendored dependencies" below for why that was
also incorrect on its own terms). Once those declarations were removed,
`deno task build:npm` succeeds outright — dnt vendors their source via Deno's
workspace resolution regardless of npm registry state, so publication status is
irrelevant to whether this package's _own_ build succeeds. Verified:
`deno task build:npm` completes,
`node
dist/esm/fsm-devstack-ts/src/cli/fsmdev.js --help` runs correctly, and
installing that `dist/` output as a dependency of a scratch project (the
`npx`-equivalent scenario above) links all three bins onto `PATH` correctly.

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
- `cli/fsmdev.ts` — the orchestrator CLI (see above)
- `cli/run-gateway.ts` / `cli/run-fsmlet.ts` — self-owned bins `fsmdev` spawns
  by name for the two long-running steps (see above); intentionally scoped down
  from the full-featured sibling CLIs they replace (e.g. `run-fsmlet.ts` is
  folder-mode only, `run-gateway.ts` always runs the poll loop). Plain top-level
  `await` throughout, same as every other CLI in this repo — no `main()` wrapper
  needed, since both are `bin` entries (see below).

`scripts/build-npm.ts` builds `index.ts` (library export) and `fsmdev.ts`/
`run-gateway.ts`/`run-fsmlet.ts` (all three `bin` entries — see above for the
empirically-verified design this rests on). Declares **no** `dependencies` on
`@pgfsm/compiler`/`@pgfsm/db`/`@pgfsm/async-worker`/`@pgfsm/sync-worker` — see
"Vendored dependencies" below for why an earlier revision's explicit
declarations were both unnecessary and misleading. Sets `test: false` in the dnt
`build()` options because this package, unlike the sibling dnt-built packages,
colocates `supervisor.test.ts` under `src/`; without that, dnt also
transforms/type-checks it as a Node test file and pulls in `@std/assert`, which
needs a newer `lib` target than this package's `compilerOptions` sets.
`postBuild()` only copies `README.md` into `dist/` when `--copy-readme` is
passed (`deno task build:npm <version> --copy-readme`, as CI does) — a plain
local `deno task build:npm` skips it, same convention as the sibling packages.

## Vendored dependencies

`@pgfsm/compiler`, `@pgfsm/db`, `@pgfsm/async-worker`, and `@pgfsm/sync-worker`
are Deno workspace-resolved imports here, not `npm:`/`jsr:` specifiers — dnt
vendors their actual source directly into this package's own `dist/` output
(verified: `dist/esm/fsm-compiler-ts/`, `dist/esm/fsm-core-async-op-worker/`,
`dist/esm/fsm-sync-worker-ts/`, `dist/esm/fsm-core-db-ts/` all appear as full
source trees inside `fsm-devstack-ts`'s own build). This is the exact same
vendoring PR #248 (closing #247) documents for `@pgfsm/db` inside
`fsm-sync-worker-ts`'s and `fsm-core-async-op-worker`'s own npm builds —
confirmed directly by building `@pgfsm/async-worker` locally and finding
`@pgfsm/db` absent from both its compiled `package.json` `dependencies` and its
`dist/node_modules`, with `@pgfsm/db`'s source vendored under
`dist/esm/fsm-core-db-ts/` instead.

Consequences:

- **Don't declare these four as npm `dependencies` in `scripts/build-npm.ts`.**
  Doing so doesn't change what the compiled code imports (it never uses the bare
  specifier — only the vendored relative path), so it would just install a
  redundant, never-executed copy, and it misleadingly implies a semver bump to
  one of those four packages reaches existing `@pgfsm/devstack` installs. It
  does not: **this package needs to be rebuilt and republished itself** for a
  fix in any of them to reach consumers. Mirrors PR #248's finding one layer
  deeper — `fsm-devstack-ts` vendors packages that themselves vendor
  `@pgfsm/db`, so a `@pgfsm/db` fix has to propagate through _two_ republish
  steps to reach an `@pgfsm/devstack` install.
- This also means `deno task build:npm` for this package doesn't need
  `@pgfsm/compiler`/`@pgfsm/async-worker`/`@pgfsm/sync-worker` to be published
  to npm at all — dnt's vendoring is driven by Deno's own workspace resolution,
  not by npm registry availability. An earlier pass in this session incorrectly
  believed the build was blocked on those three packages' publication status;
  that was purely a consequence of having declared them as `dependencies` in the
  first place (which forced a real `npm install` lookup that 404'd). Removing
  the declarations was the actual fix.
- If `docs/schema-change-propagation.md` gains a step for this (mirroring PR
  #248's addition there for `fsm-sync-worker-ts`/ `fsm-core-async-op-worker`),
  `fsm-devstack-ts` needs the same treatment — not done here to avoid
  conflicting with that still-open PR.

## Commands

```bash
deno task fsmdev    # deno run --allow-all src/cli/fsmdev.ts
deno task test      # deno test --allow-all src/
deno task check     # deno check src/index.ts src/cli/fsmdev.ts src/cli/run-gateway.ts src/cli/run-fsmlet.ts
deno task build:npm # scripts/build-npm.ts (dnt npm build — succeeds; generate-all still fails under the built Node output, see above)
```
