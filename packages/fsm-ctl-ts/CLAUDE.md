# CLAUDE.md — `@pgfsm/ctl` (`packages/fsm-ctl-ts/`)

Scoped guidance for `@pgfsm/ctl`, bin `pgfsmctl` (SPEC-005,
`docs/specs/spec-005-cli-consolidation-pgfsmctl.md`). Repo-wide conventions and
session protocol live in the root `CLAUDE.md` / `AGENTS.md`. `README.md` is the
npm-facing document; keep source-only detail here. Full CLI reference:
`docs/guides/CLI-USAGE.md`.

## What it is

The ops CLI for a pgfsm deployment: `fsm load` (SPEC-006),
`db cron register|unregister|status`, `instance create|resume|send|stop`,
`scheduler run` (SPEC-003's fsmscheduler fallback), plus the local `config`
(profiles), `completion` and `version`. Conventions (SPEC-009 §4–6, #471):
noun-verb with a tier per noun, `-o table|json|ids`, the exit-code table in
`src/exit.ts`, and profiles. It replaced the `pgcron`, `fsmctl` and
`fsmscheduler` bins that `@pgfsm/sync-worker` ≤ 0.2 shipped, which is now
library-only.

Package boundary (SPEC-005's decision driver — one compatibility axis per
package):

- `@pgfsm/ctl` tracks `@pgfsm/db` and the `fsm_core` migrations. It depends only
  on `@pgfsm/db`, `@pgfsm/logging`, `pg`, `dotenv`, `@std/cli`, `@std/yaml`,
  never on `@pgfsm/compiler` or `@pgfsm/sync-worker`, so an ops Job image stays
  small.
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
`.env`; `DATABASE_URL`, `PGFSM_DB_URL` and `PGFSM_PROFILE` unset for the child,
and `PGFSM_CONFIG_DIR` pointed at a temp dir so the real `~/.config/pgfsm` is
never touched) and assume the process cwd is the repo root. Most cover argument
handling, exit codes, output and profile precedence (read from the
`PGFSMCTL_LOG_LEVEL=debug` "Database from …" line, against closed ports). The DB
tests (`fsm load` end to end, exit `4` for an unknown instance,
`db cron status`) run only when the test process has `DATABASE_URL` (e.g. local
Supabase) and pass it as `--db-url`. `test/api-tier.test.ts` also starts the
real API (`apps/fsm-core-ts-hono-deno/src/cli/index.ts --enable-admin-api`) on a
free port against that database, to test `db key create`, `key …` and
`fsm load`'s tier choice end to end; CI runs these in the pgTAP job. Check
`db cron` changes against local Supabase by hand (`status` → `unregister` →
`register` → `status`), and put the job's original schedule back afterwards,
since that database is shared.

## Layout

- `src/cli/pgfsmctl.ts` — the bin: `--version`/`--help`, dispatches the first
  argument (the noun) to a command module, and is the only place that exits:
  commands throw a `CtlError` (or anything else), and it maps that to an exit
  code via `exitCodeFor`. Ctrl-C exits 130 (except `scheduler run`, which stops
  gracefully first). Configures logging once (ADR-001) via `src/logger.ts`, with
  every level on **stderr** (`consoleStream: "stderr"`): stdout is data.
- `src/commands/{db,fsm,instance,scheduler,config,completion}.ts` — one module
  per noun, each exporting `<noun>Command(argv)`, parsing via `src/args.ts`'s
  `parseCommandArgs` (common `-d/--db-url`, `--profile`, `-o`, `-h`; unknown
  options are a usage error) and `verbOf`. `instance.ts` is the old `fsmctl.ts`,
  `db.ts` the old `pgcron.ts`, `scheduler.ts` the old `fsmscheduler.ts` CLI
  (moved with `git mv`, so `git log --follow` works). `tree.ts` is the command
  tree that `--help`'s tiers and `completion` share: add a noun, flag or verb
  there too. `fsm.ts` (`fsm load`, SPEC-006) walks
  `<folder>/<fsmName>/<vNN>/fsm.json` itself and hands the parsed batch to
  `@pgfsm/db`'s `loadFsmDefinitions`; it deliberately copies the compiler's
  `v\d{2}` version-folder rule instead of importing `@pgfsm/compiler`. Log lines
  are built as plain strings because LogTape quotes interpolated string values.
- `src/db-target.ts` — `resolveDbUrl` (`--db-url` → explicit `--profile` /
  `PGFSM_PROFILE` → `PGFSM_DB_URL` / `DATABASE_URL`, loading `./.env` → current
  profile; an explicit profile beats the env on purpose, see the doc comment)
  and `withPool`, one single-connection Pool per one-shot command (root
  `CLAUDE.md` #4).
- `src/api-target.ts` — `resolveApiTarget`: URL and key resolved separately
  (`--url`/`--api-key` → explicit profile, which then replaces env and current
  profile → `PGFSM_URL`/`PGFSM_API_KEY` → current profile). Undefined when no
  URL resolves, so `fsm load` can fall back to DB-direct.
- `src/api-client.ts` — `apiRequest`: bearer key, JSON, and HTTP status → exit
  code (401/403 → 3, 404 → 4 with an `--enable-admin-api` hint on `/admin/*`,
  else 1 with the server's message and `problems`).
- `src/commands/key.ts` (`key create|list|revoke`, API tier) and `db key create`
  in `db.ts` (DB-direct bootstrap key); `src/key-role.ts` maps
  `--role admin|operator`.
- `src/config.ts` — profiles: `config.yaml` (no secrets) and `credentials.json`
  (mode 0600) in `$PGFSM_CONFIG_DIR` or the OS config dir + `/pgfsm`.
- `src/exit.ts` (`ExitCode`, `CtlError`), `src/output.ts` (`printList`,
  `printRecord` for `-o table|json|ids`), `src/args.ts`.
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
