# CLAUDE.md — Dev Stack Orchestrator (`packages/fsm-devstack-ts/`)

Scoped guidance for `@pgfsm/devstack`. Repo-wide conventions and session
protocol live in the root `CLAUDE.md` / `AGENTS.md`.

## What it is

`fsmdev` (`src/cli/fsmdev.ts`), a one-command local dev-stack launcher (issue
#238). Sequence:

1. `generate-all` (`@pgfsm/compiler`) — one-shot, must succeed first.
2. `pgcron` registration (`@pgfsm/sync-worker`) — one-shot, idempotent.
3. Activity Gateway + generated TypeScript worker SDK (`@pgfsm/async-worker`)
   and `fsmlet` (`@pgfsm/sync-worker`) — spawned and supervised together via
   `runSupervised`. `Ctrl+C` stops all three; if any one exits on its own the
   rest are torn down (see failure policy below).

Sibling CLIs are located by resolving relative paths from `import.meta.url`
(`packages/fsm-devstack-ts/src/cli/fsmdev.ts` →
`../../../<package>/src/cli/<file>.ts`) rather than by shelling out through
`npx`/published bins — this only works because `fsmdev` lives inside the same
monorepo workspace as the CLIs it orchestrates. The generated worker SDK's path
is computed at runtime instead (`generate-all` writes it one level above
`--fsm-folder`, per `fsm-compiler-ts/CLAUDE.md`'s "generate-async-logic" note)
since it doesn't exist until after step 1 runs. Worker SDK launch is
TypeScript-only for now — polyglot (python/rust/go) worker processes aren't
wired up.

None of this repo's other CLIs spawn or supervise child processes, so
`src/supervisor.ts` (issue #239) is the first such primitive here.

**`fsmdev` itself still isn't `npx`-runnable (tracked separately)**: it locates
sibling CLIs via `import.meta.url`-relative paths and shells out to them with
`Deno.Command(Deno.execPath(), ["run", "--allow-all", <path>, ...])` — that only
works inside this monorepo's Deno-native dev flow. Making `fsmdev` itself
portable needs (a) dispatching to the sibling packages' installed npm bins under
Node instead of `deno run <path>`, and (b) a decision on how the generated
`worker-sdk-generated/typescript/cli.ts` runs without Deno present (it's
project-generated TypeScript source, not a published bin) — real product
decisions, not filed as follow-up work yet.

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
`compilerOptions` sets.

## Commands

```bash
deno task fsmdev    # deno run --allow-all src/cli/fsmdev.ts
deno task test      # deno test --allow-all src/
deno task check     # deno check src/index.ts src/cli/fsmdev.ts
deno task build:npm # scripts/build-npm.ts (dnt npm build, library export only)
```
