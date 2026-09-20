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

**No npm/npx build yet, and it may not be straightforward when added**: `fsmdev`
and `supervisor.ts` are built entirely on `Deno.Command`, which dnt's Deno shim
doesn't implement (see `fsm-compiler-ts/CLAUDE.md`'s npm-publish section, which
hit the same wall for a different reason) — this package likely can't ship as a
working `npx`-installable CLI without a different build approach or a Node-side
process-spawn shim.

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
- `cli/fsmdev.ts` — the orchestrator CLI (see above)

## Commands

```bash
deno task fsmdev # deno run --allow-all src/cli/fsmdev.ts
deno task test   # deno test --allow-all src/
deno task check  # deno check src/index.ts src/cli/fsmdev.ts
```
