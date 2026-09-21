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

**`fsmdev` itself still isn't `npx`-runnable (tracked in #245, narrowed)**: the
`Deno.execPath()`/`["run", "--allow-all", <path>, ...]` invocation used to
launch `run-gateway.ts`/`run-fsmlet.ts` (and, previously, the sibling CLIs
directly) is still Deno-only — that's the one remaining piece. Under Node/npm,
`fsmdev` would need `run-gateway.ts`/`run-fsmlet.ts` registered as `bin` entries
in this package's own dnt build (see below) and invoked by name via `PATH`,
instead of `deno run <self-relative-path>`. The two harder problems #245
originally scoped — resolving a _sibling package's_ CLI file/bin, and how the
generated worker SDK executes without Deno — are both gone: sibling dispatch is
now a library import (this section), and worker-SDK execution was never fsmdev's
problem to solve (point 2 above).

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
  results to the `deno test` suite. `fsmdev.ts` itself is not part of that dnt
  build yet (see above).

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
  folder-mode only, `run-gateway.ts` always runs the poll loop)

`scripts/build-npm.ts` builds only the `index.ts` library export via `@deno/dnt`
— no `bin` entry for `fsmdev` yet, since it isn't portable (see above). Sets
`test: false` in the dnt `build()` options because this package, unlike the
sibling dnt-built packages, colocates `supervisor.test.ts` under `src/`; without
that, dnt also transforms/type-checks it as a Node test file and pulls in
`@std/assert`, which needs a newer `lib` target than this package's
`compilerOptions` sets. `postBuild()` only copies `README.md` into `dist/` when
`--copy-readme` is passed (`deno task build:npm <version>
--copy-readme`, as CI
does) — a plain local `deno task build:npm` skips it, same convention as the
sibling packages.

## Commands

```bash
deno task fsmdev    # deno run --allow-all src/cli/fsmdev.ts
deno task test      # deno test --allow-all src/
deno task check     # deno check src/index.ts src/cli/fsmdev.ts
deno task build:npm # scripts/build-npm.ts (dnt npm build, library export only)
```
