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

1. `generate-all` (`@pgfsm/compiler`) — one-shot, must succeed first.
2. Prints the exact start command for every worker-SDK language `generate-all`
   actually generated (typescript/python/rust/go — whichever subdirectories
   exist under `<app-root>/worker-sdk-generated/`). `fsmdev` does **not** launch
   these itself: they're polyglot, per-project generated code with different
   toolchains (`deno run`, `python3`, `cargo run`, `go run`), so starting them
   is left to the user, one terminal each.
3. `pgcron` registration (`@pgfsm/sync-worker`) — one-shot, idempotent.
4. Activity Gateway (`@pgfsm/async-worker`) and `fsmlet` (`@pgfsm/sync-worker`)
   — spawned and supervised together via `runSupervised`. `Ctrl+C` stops both;
   if either exits on its own the other is torn down (see failure policy below).

Sibling CLIs (`@pgfsm/compiler`/`@pgfsm/async-worker`/`@pgfsm/sync-worker`) are
located by resolving relative paths from `import.meta.url`
(`packages/fsm-devstack-ts/src/cli/fsmdev.ts` →
`../../../<package>/src/cli/<file>.ts`) rather than by shelling out through
`npx`/published bins — this only works because `fsmdev` lives inside the same
monorepo workspace as the CLIs it orchestrates. The generated worker SDK's
directory (`<app-root>/worker-sdk-generated/<lang>/`) is similarly computed at
runtime, but only to print each language's start command
(`printWorkerSdkStartInstructions`) — `fsmdev` never launches worker-SDK
processes itself; see the numbered sequence above for why.

None of this repo's other CLIs spawn or supervise child processes, so
`src/supervisor.ts` (issue #239) is the first such primitive here.

**`fsmdev` itself still isn't `npx`-runnable (tracked in #245)**: it locates
`@pgfsm/compiler`/`@pgfsm/async-worker`/`@pgfsm/sync-worker`'s CLIs via
`import.meta.url`-relative paths and shells out to them with
`Deno.Command(Deno.execPath(), ["run", "--allow-all", <path>, ...])` — that only
works inside this monorepo's Deno-native dev flow. Making `fsmdev` portable
needs dispatching to those sibling packages' installed npm bins under Node
instead of `deno run <path>`. The other half of #245's original scope — how the
generated worker SDK executes without Deno present — is now moot: `fsmdev` never
launches worker-SDK processes itself (see above), so there's no cross-runtime
execution question for them at all.

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
