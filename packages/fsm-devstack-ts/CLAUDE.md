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

**`fsmdev` is now cross-runtime end to end (#245), by resolving the compiled
sibling path directly rather than adding more public bins.** `fsmdev.ts` is this
package's `bin` (see `scripts/build-npm.ts`); `run-gateway.ts`/ `run-fsmlet.ts`
are deliberately **plain** (non-`bin`) entries — `fsmdev` locates and invokes
their compiled output itself instead of exposing them as their own installable
commands:

```ts
const isDeno = typeof process !== "undefined" && !!process.versions?.deno;
const GATEWAY_CLI = new URL(
  `./run-gateway.${isDeno ? "ts" : "js"}`,
  import.meta.url,
);
// under Deno: cmd = Deno.execPath(), args = ["run", "--allow-all", path, ...]
// under Node: cmd = process.execPath, args = [path, ...]
```

Three things had to be verified empirically before this was safe to write (see
git history for the throwaway probes that established them, not kept in the
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
- **dnt preserves this file's directory layout when compiling**
  (`src/cli/run-gateway.ts` → `dist/esm/cli/run-gateway.js`), so the same
  self-relative `import.meta.url` resolution `fsmdev.ts` already used for the
  `.ts` source works against the compiled `.js` sibling too — just with a
  different extension and a different invocation command.
- Separately: dnt refuses top-level `await` when building a **plain** entry's
  CJS/UMD output (a `bin` entry has no such restriction — verified with a
  throwaway probe). `run-gateway.ts`/`run-fsmlet.ts` both had top-level `await`
  throughout, matching every other CLI in this repo, so both were restructured
  into an `async function main()` invoked as `main().catch(...)` — no behavior
  change, purely to satisfy dnt.

Every other `Deno.*` call in these three files (`Deno.args`, `Deno.exit`,
`Deno.env.get`, `Deno.stat`, `Deno.readDirSync`, `Deno.addSignalListener`)
needed **no changes** — dnt's shim already implements all of them faithfully
(verified empirically against the actual compiled+`node`-executed output);
`Deno.Command` remains the one Deno API with no shim at all (per
`@deno/shim-deno`'s own progress tracking), which is exactly why `supervisor.ts`
moved off it in #244 and why `fsmdev`'s own spawn calls need the `isDeno` branch
above instead of a shimmed call.

**Still not actually buildable or runnable via `npx` today — this is unverified,
not just untested.** `@pgfsm/compiler`, `@pgfsm/async-worker`, and
`@pgfsm/sync-worker` (which `fsmdev.ts`/`run-gateway.ts`/`run-fsmlet.ts` all
import) are not published to npm yet — only `@pgfsm/db` is.
`deno task
build:npm` fails at its `npm install` step with three 404s; confirmed
this is the _only_ failure (everything before it — the Deno-side transform, the
`bin`/plain entry split, the dependency declarations in `scripts/build-npm.ts` —
succeeds). The code is written to be correct once those three packages are
published; there is no way to verify a real `npx -p @pgfsm/devstack -- fsmdev`
run until then.

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
- `cli/run-gateway.ts` / `cli/run-fsmlet.ts` — self-owned runners `fsmdev`
  spawns for the two long-running steps (see above); intentionally scoped down
  from the full-featured sibling CLIs they replace (e.g. `run-fsmlet.ts` is
  folder-mode only, `run-gateway.ts` always runs the poll loop). Both wrap their
  body in `async function main()` + `main().catch(...)` rather than top-level
  `await` — required because dnt builds them as plain entries (see below), which
  don't support top-level await the way a `bin` entry does.

`scripts/build-npm.ts` builds `index.ts` (library export), `fsmdev.ts` (this
package's `bin`), and `run-gateway.ts`/`run-fsmlet.ts` (plain entries — see
above for why they aren't bins too, and for the empirically-verified design this
rests on). Declares explicit `dependencies` on `@pgfsm/compiler`/
`@pgfsm/db`/`@pgfsm/async-worker`/`@pgfsm/sync-worker`, since those are
workspace-only specifiers dnt can't infer from an `npm:` import the way it does
for `pg`. **This build cannot currently succeed past `npm install`** —
`@pgfsm/compiler`/`@pgfsm/async-worker`/`@pgfsm/sync-worker` aren't published to
npm yet (see above). Sets `test: false` in the dnt `build()` options because
this package, unlike the sibling dnt-built packages, colocates
`supervisor.test.ts` under `src/`; without that, dnt also transforms/
type-checks it as a Node test file and pulls in `@std/assert`, which needs a
newer `lib` target than this package's `compilerOptions` sets. `postBuild()`
only copies `README.md` into `dist/` when `--copy-readme` is passed
(`deno
task build:npm <version> --copy-readme`, as CI does) — a plain local
`deno
task build:npm` skips it, same convention as the sibling packages.

## Commands

```bash
deno task fsmdev    # deno run --allow-all src/cli/fsmdev.ts
deno task test      # deno test --allow-all src/
deno task check     # deno check src/index.ts src/cli/fsmdev.ts src/cli/run-gateway.ts src/cli/run-fsmlet.ts
deno task build:npm # scripts/build-npm.ts (dnt npm build — see above, currently fails at npm install)
```
