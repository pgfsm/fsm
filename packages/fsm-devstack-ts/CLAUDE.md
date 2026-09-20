# CLAUDE.md — Dev Stack Orchestrator (`packages/fsm-devstack-ts/`)

Scoped guidance for `@pgfsm/devstack`. Repo-wide conventions and session
protocol live in the root `CLAUDE.md` / `AGENTS.md`.

## What it is

`fsmdev`, a one-command local dev-stack launcher: run `generate-all`
(`@pgfsm/compiler`), then spawn and supervise the Activity Gateway + generated
worker SDK (`@pgfsm/async-worker`) and `fsmlet` + `pgcron` registration
(`@pgfsm/sync-worker`) as a group (issue #238). None of this repo's other CLIs
spawn or supervise child processes, so `src/supervisor.ts` (issue #239) is the
first such primitive here.

## Process supervision (`src/supervisor.ts`)

- `runSupervised(specs, options?)` — spawns every `ProcessSpec`, forwards
  `SIGINT`/`SIGTERM` to all children, and resolves with the exit code the CLI
  should pass to `Deno.exit`.
- `runProcessGroup(specs, shutdownSignal)` — the core race logic, decoupled from
  real OS signals via an injected `Promise<Deno.Signal>` so tests can drive
  shutdown without sending signals to the test process itself.
- **Failure policy (decided on #239):** if any child exits on its own before
  shutdown was requested, the supervisor tears down all remaining children and
  exits non-zero (fail-fast) — a dead gateway/fsmlet/pgcron process usually
  makes the rest of the stack non-functional anyway, so continuing risks a
  silent partial-stack state.

## Structure (`src/`)

- `supervisor.ts` — spawn/signal/failure-policy primitive
- `supervisor.test.ts` — covers early-exit teardown,
  clean-exit-is-still-a-failure, requested-shutdown, and empty-spec-list
  rejection
- `index.ts` — barrel export
- `cli/` — not yet added; `fsmdev` itself is tracked in #238

## Commands

```bash
deno task test   # deno test --allow-all src/
deno task check  # deno check src/index.ts
```
