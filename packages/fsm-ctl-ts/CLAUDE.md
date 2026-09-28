# CLAUDE.md — `@pgfsm/ctl` (`packages/fsm-ctl-ts/`)

Scoped guidance for `@pgfsm/ctl`, bin `pgfsmctl` (SPEC-005,
`docs/specs/spec-005-cli-consolidation-pgfsmctl.md`). Repo-wide conventions and
session protocol live in the root `CLAUDE.md` / `AGENTS.md`. `README.md` is the
npm-facing document; keep source-only detail here. Full CLI reference:
`docs/guides/CLI-USAGE.md`.

## What it is

The ops CLI for a running pgfsm database: `pgcron register|unregister|status`,
`instance create|resume|send|stop`, and `scheduler run` (SPEC-003's fsmscheduler
fallback). It replaced the `pgcron`, `fsmctl` and `fsmscheduler` bins that
`@pgfsm/sync-worker` ≤ 0.2 shipped, which is now library-only.

Package boundary (SPEC-005's decision driver — one compatibility axis per
package):

- `@pgfsm/ctl` tracks `@pgfsm/db` and the `fsm_core` migrations. It depends only
  on `@pgfsm/db`, `@pgfsm/logging`, `pg`, `dotenv`, `@std/cli`, never on
  `@pgfsm/compiler` or `@pgfsm/sync-worker`, so an ops Job image stays small.
- `@pgfsm/cli` (`pgfsm`) is the project-aware scaffolder and tracks the compiler
  and SDKs. Don't add project-aware commands here, or DB commands there.

## Commands

```bash
deno task pgfsmctl -- <noun> <verb> [options]   # run from source
deno task test          # from the repo root: deno test --allow-all packages/fsm-ctl-ts
deno task check
deno task build:npm <version>   # dnt build to dist/
```

Tests drive the CLI as a subprocess from an empty temp dir (no project, no
`.env`, `DATABASE_URL` unset) and assume the process cwd is the repo root. They
cover argument handling only, because CI's `deno test` job has no database. The
DB paths are thin calls into `@pgfsm/db`. Check `pgcron` changes against local
Supabase by hand (`status` → `unregister` → `register` → `status`), and put the
job's original schedule back afterwards, since that database is shared.

## Layout

- `src/cli/pgfsmctl.ts` — the bin: `--version`/`--help`, dispatches the first
  argument (the noun) to a command module. Configures logging once (ADR-001) via
  `src/logger.ts`.
- `src/commands/{pgcron,instance,scheduler}.ts` — one module per noun, each
  exporting `<noun>Command(argv)`. Each parses its own flags and treats the
  first positional as the verb. `instance.ts` is the old `fsmctl.ts`,
  `pgcron.ts` the old `pgcron.ts`, `scheduler.ts` the old `fsmscheduler.ts` CLI
  (moved with `git mv`, so `git log --follow` works).
- `src/commands/db.ts` — `resolveDbUrl` (`--db-url` → `DATABASE_URL`, loading
  `./.env`) and `withPool`, which opens one single-connection Pool per one-shot
  command (root `CLAUDE.md` #4).
- `src/scheduler/fsmscheduler.ts` — the `runFsmScheduler` loop (moved from
  `fsm-sync-worker-ts/src/fsmscheduler/`), exported from `src/index.ts`.
- `src/version.ts` / `src/invocation.ts` — Deno-native defaults swapped by
  `scripts/build-npm.ts` for `version.node.ts` (generated per build, gitignored)
  and `invocation.node.ts` (committed), same pattern as `@pgfsm/cli`.

## npm build

`scripts/build-npm.ts` (dnt) emits one bin, `pgfsmctl`. With a single bin,
`npx @pgfsm/ctl …` works without `-p` (the multi-bin gotcha `@pgfsm/sync-worker`
used to have). `@pgfsm/db` and `@pgfsm/logging` map to real npm dependencies at
`^<their deno.json version>`. A ctl release that uses new `@pgfsm/db` exports
therefore needs that db version published first.
