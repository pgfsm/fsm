# CLAUDE.md — `@pgfsm/ctl` (`packages/fsm-ctl-ts/`)

Scoped guidance for `@pgfsm/ctl`, bin `pgfsmctl` (SPEC-005,
`docs/specs/spec-005-cli-consolidation-pgfsmctl.md`). Repo-wide conventions and
session protocol live in the root `CLAUDE.md` / `AGENTS.md`. `README.md` is the
npm-facing document; keep source-only detail here. Full CLI reference:
`docs/guides/CLI-USAGE.md`.

## What it is

The ops CLI for a pgfsm deployment, and an API client only (SPEC-016, #690):
`fsm load|list|get` (SPEC-006), `instance create|resume|send|stop|list|get`,
`key create|list|revoke`, `scheduler status|register` (the pg_cron job, through
`/admin/scheduler`), plus the local `config` (profiles), `completion` and
`version`. **No command opens a Postgres connection**: `src/` imports neither
`pg` nor `@pgfsm/db` (`test/cli.test.ts` checks), like `kubectl` and the
Kubernetes API server. Installing fsm_core and the first admin key happen
outside it (`fsm_core--<v>.sql`, `npx @pgfsm/api key bootstrap`). Conventions
(SPEC-009 §4, §6, #471): noun-verb, `-o table|json|ids`, the exit-code table in
`src/exit.ts`, and profiles. SPEC-016 removed `db cron`, `db key create`,
`scheduler run`, `--db-url`, profiles' `db_url`/`db_password`/`tier` and
`PGFSM_DB_URL`/`PGFSM_TIER`.

Package boundary (SPEC-005's decision driver — one compatibility axis per
package):

- `@pgfsm/ctl` tracks `@pgfsm/api`'s routes. It depends only on
  `@pgfsm/logging`, `dotenv`, `@std/cli`, `@std/yaml`; the request and response
  shapes it needs are declared in `src/types.ts`.
- `@pgfsm/cli` (`pgfsm`) is the project-aware scaffolder and tracks the compiler
  and SDKs. Don't add project-aware commands here.

## Commands

```bash
deno task pgfsmctl -- <noun> <verb> [options]   # run from source
deno task test          # from the repo root: deno test --allow-all packages/fsm-ctl-ts
deno task check
deno task build:npm <version>   # dnt build to dist/
```

Tests drive the CLI as a subprocess from an empty temp dir (no project, no
`.env`; `PGFSM_URL`, `PGFSM_API_KEY` and `PGFSM_PROFILE` unset for the child,
and `PGFSM_CONFIG_DIR` pointed at a temp dir so the real `~/.config/pgfsm` is
never touched) and assume the process cwd is the repo root. `test/cli.test.ts`
covers argument handling, exit codes, output and profile precedence (read from
the `PGFSMCTL_LOG_LEVEL=debug` "API from …" line, against closed ports), with no
API. `test/api-tier.test.ts` starts the real API
(`packages/fsm-api-ts/src/cli/index.ts --enable-admin-api`) on a free port
against `DATABASE_URL` (the schema owner, e.g. local Supabase), mints keys with
`@pgfsm/db`'s `createApiKey` (a test-only import, which is why `deno.json` keeps
`pg`), and runs every command end to end; CI runs it in the pgTAP job.
`scheduler register` there puts the default schedule back afterwards, since that
database is shared.

## Layout

- `src/cli/pgfsmctl.ts` — the bin: `--version`/`--help`, dispatches the first
  argument (the noun) to a command module, and is the only place that exits:
  commands throw a `CtlError` (or anything else), and it maps that to an exit
  code via `exitCodeFor`. Ctrl-C exits 130. Configures logging once (ADR-001)
  via `src/logger.ts`, with every level on **stderr**
  (`consoleStream: "stderr"`): stdout is data.
- `src/commands/{fsm,instance,key,scheduler,config,completion}.ts` — one module
  per noun, each exporting `<noun>Command(argv)`, parsing via `src/args.ts`'s
  `parseCommandArgs` (common `--url`, `--api-key`, `--profile`, `-o`, `-h`;
  unknown options are a usage error) and `verbOf`, validating arguments before
  resolving the API, then calling it through `requireApiTarget` + `apiRequest`.
  `fsm.ts` (`fsm load`, SPEC-006) walks `<folder>/<fsmName>/<vNN>/fsm.json`
  itself and posts the batch to `/admin/definitions`; it deliberately copies the
  compiler's `v\d{2}` version-folder rule instead of importing
  `@pgfsm/compiler`. `tree.ts` is the command tree that `--help` and
  `completion` share: add a noun, flag or verb there too. Log lines are built as
  plain strings because LogTape quotes interpolated string values.
- `src/api-target.ts` — `resolveApiTarget`: URL and key resolved separately
  (`--url`/`--api-key` → explicit profile, which then replaces env and current
  profile → `PGFSM_URL`/`PGFSM_API_KEY`, loading `./.env` → current profile);
  `requireApiTarget` turns "none" into exit 2 naming the ways to configure one.
- `src/api-client.ts` — `apiRequest`: bearer key, JSON, and HTTP status → exit
  code (401/403 → 3, 404 → 4 with an `--enable-admin-api` hint on `/admin/*`,
  else 1 with the server's message and `problems`).
- `src/key-role.ts` maps `--role admin|operator`; `src/types.ts` the API's
  shapes.
- `src/config.ts` — profiles: `config.yaml` (the API `url`, no secrets) and
  `credentials.json` (`api_key`, mode 0600) in `$PGFSM_CONFIG_DIR` or the OS
  config dir + `/pgfsm`. Older profiles' `db_url`/`tier`/`db_password` are
  ignored and dropped on the next `config set`.
- `src/exit.ts` (`ExitCode`, `CtlError`), `src/output.ts` (`printList`,
  `printRecord` for `-o table|json|ids`), `src/args.ts`.
- `src/version.ts` / `src/invocation.ts` — Deno-native defaults swapped by
  `scripts/build-npm.ts` for `version.node.ts` (generated per build, gitignored)
  and `invocation.node.ts` (committed), same pattern as `@pgfsm/cli`.
- The fsmscheduler loop (`runFsmScheduler`) that `scheduler run` used to run now
  lives with the journey tests that use it:
  `apps/fsm-core-example/test-support/fsm-scheduler.ts`.

## npm build

`scripts/build-npm.ts` (dnt) emits one bin, `pgfsmctl`. With a single bin,
`npx @pgfsm/ctl …` works without `-p` (the multi-bin gotcha `@pgfsm/sync-worker`
used to have). `@pgfsm/logging` maps to a real npm dependency at
`^<its deno.json version>`; there's no `@pgfsm/db` or `pg` dependency.
