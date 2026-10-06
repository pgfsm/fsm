# pgfsmctl — CLI Usage Guide

`@pgfsm/ctl` ships one bin, `pgfsmctl`, for operating a pgfsm deployment
(SPEC-005, conventions from SPEC-009). Commands are `<noun> <verb>`, and each
noun has a **tier**: DB-direct commands talk to Postgres, local ones touch only
your machine. (SPEC-009 adds API-tier commands in #473.)

| Command                                     | Tier      | Kind     | Role                                                                                       | Replaces (`@pgfsm/sync-worker` ≤ 0.2) |
| ------------------------------------------- | --------- | -------- | ------------------------------------------------------------------------------------------ | ------------------------------------- |
| `fsm load <folder>`                         | DB-direct | one-shot | Load FSM definitions (`fsm.json`) into the database — a deploy step (SPEC-006)             | `@pgfsm/compiler -c load`             |
| `db cron register \| unregister \| status`  | DB-direct | one-shot | Manage the `pg_cron` job that drains the dispatch queue — the primary scheduler (SPEC-003) | `pgcron`                              |
| `instance create \| resume \| send \| stop` | DB-direct | one-shot | Instance control (kubectl equivalent) against the dispatch-queue model, straight to the DB | `fsmctl -c <command>`                 |
| `scheduler run`                             | DB-direct | long-run | The standing fsmscheduler process (kube-scheduler equivalent) — **fallback only**          | `fsmscheduler`                        |
| `config set \| use \| list \| show`         | local     | one-shot | Named targets (profiles): database and API URLs, secrets kept apart                        | —                                     |
| `completion bash \| zsh \| fish`            | local     | one-shot | Print a shell completion script                                                            | —                                     |
| `version`                                   | local     | one-shot | Print the version (`-o json` for `{ "version": … }`)                                       | —                                     |

No command needs a pgfsm project (`pgfsm.config.json`). The `db` noun is always
DB-direct: its commands are deploy steps that must work before the REST API is
up. `db migrate` is reserved.

> **`fsmlet`** (the kubelet-equivalent node agent) is not a `pgfsmctl` command:
> it runs your sync-operation code, so a project embeds it —
> `sync-worker/typescript/run-sync-worker.ts` calls `runFsmlet` from
> `@pgfsm/sync-worker`.

---

## Prerequisites and invocation

- **Installed** (Node): `npx @pgfsm/ctl <noun> <verb> [options]` — the package
  has a single bin, so no `-p … --` form is needed. A pgfsm project pins it as
  `npm run db:load` and `npm run db:pgcron`.
- **From this repo** (Deno, see `.prototools`): from `packages/fsm-ctl-ts/`,
  `deno task pgfsmctl <noun> <verb> [options]`; or from the repo root,
  `deno run --allow-all packages/fsm-ctl-ts/src/cli/pgfsmctl.ts …`.

Examples below use `pgfsmctl` for whichever of these you use.
`pgfsmctl --version` (or `pgfsmctl version`) prints the bare version;
`pgfsmctl --help` and `pgfsmctl <noun> --help` print usage. Unknown options are
an error (exit `2`), not ignored.

### Which database (DB-direct commands)

First match wins:

1. `-d/--db-url <url>`
2. a profile chosen explicitly: `--profile <name>`, else `$PGFSM_PROFILE`
3. `$PGFSM_DB_URL`, else `$DATABASE_URL` (a `.env` in the current directory is
   read first)
4. the current profile (`pgfsmctl config use <name>`)

An explicitly chosen profile beats the environment variables on purpose: since
`./.env` is read automatically, `--profile prod` run inside a project would
otherwise quietly use that project's local `DATABASE_URL`. Run with
`PGFSMCTL_LOG_LEVEL=debug` to see which source was used. With none of them set,
a command exits `2` before connecting.

### Output

`-o/--output table|json|ids` (default `table`). Data goes to **stdout**, logs to
**stderr**, so `pgfsmctl … -o json | jq` and
`ID=$(pgfsmctl instance create … -o ids)` always get clean data. `json` is never
truncated; `ids` prints one identifier per line (`<fsmName>/<version>` for
`fsm load`, the instance UUID for `instance`, the profile name for `config`).
`scheduler run` prints logs only, so it takes no `-o`.

---

## `fsm load` — FSM definitions

```bash
pgfsmctl fsm load <folder>   # e.g. `fsm` in a pgfsm project
```

Loads every `<folder>/<fsmName>/<version>/fsm.json` (version folders are `v01`,
`v02`, …) into `fsm_core.fsm_json` and the state/transition tables, as one batch
(SPEC-006):

1. **Validated before anything is written.** A child FSM that a definition
   invokes (`asyncOperationType: "fsm"`) must be in the folder or already
   loaded, and the batch must have no dependency cycle.
2. **Children first.** A definition is loaded after every child FSM it invokes,
   whatever order the folders sort in.
3. **One transaction.** Any failure rolls back the whole batch; the command
   prints every problem and exits `1` (`3` if the database denied it).

Re-running it is safe: a definition already loaded with identical content is
reported `unchanged`. A definition is immutable per version, so changed content
under a loaded version is refused; give the changed `fsm.json` a new version.
Concurrent runs are serialized per name/version in the database. A missing
folder, or one with no `fsm.json`, exits `2`.

Run it on every deploy, after migrations and **before** starting sync workers: a
worker refuses to start while an FSM version it serves is missing from the
database, or differs from the `fsm.json` it was compiled from. It replaces
`@pgfsm/compiler`'s deprecated `-c load`.

| Flag               | Alias | Description                                                             |
| ------------------ | ----- | ----------------------------------------------------------------------- |
| `--db-url <url>`   | `-d`  | Postgres URL (see [Which database](#which-database-db-direct-commands)) |
| `--profile <name>` |       | Use this profile's `db_url`                                             |
| `--output <fmt>`   | `-o`  | `table` (FSM, version, status), `json` or `ids`                         |
| `--help`           | `-h`  | Print help and exit                                                     |

---

## `db cron` — the pg_cron scheduler job

```bash
pgfsmctl db cron register [-s <cron>]   # default schedule: "5 seconds"
pgfsmctl db cron unregister
pgfsmctl db cron status
```

`register` idempotently (re)registers the `fsm_schedule_all_pending` job, which
calls `fsm_core.schedule_all_pending()` on the schedule to drain
`fsm_dispatch_queue` (see `spec-003-pgcron-fsm-scheduler.md`). It unschedules
any existing job of that name first, so re-running it (e.g. to change the
schedule) is safe.

Neither `supabase db reset` (local dev) nor the applied `supabase/migrations/`
(production) register the job on their own: `cron.schedule()` is a data-level
side effect (a row in `cron.job`), which `supabase db diff` can't capture. Run
`register` once after migrations apply, in every environment — in Kubernetes, as
a Job or init container. CI's pgTAP job does the same before its tests.

`unregister` removes the job and succeeds whether or not it existed. `status`
prints the job (id, schedule, active, command) and exits **`5`** when none is
registered, so it doubles as a deploy check.

| Flag                | Alias | Description                                                |
| ------------------- | ----- | ---------------------------------------------------------- |
| `--schedule <cron>` | `-s`  | `pg_cron` schedule for `register` (default: `"5 seconds"`) |
| `--db-url <url>`    | `-d`  | Postgres URL                                               |
| `--profile <name>`  |       | Use this profile's `db_url`                                |
| `--output <fmt>`    | `-o`  | `table`, `json` or `ids` (the job name)                    |
| `--help`            | `-h`  | Print help and exit                                        |

---

## `instance` — FSM instance control

```bash
pgfsmctl instance create -n creditCheck -V v01
pgfsmctl instance create -n creditCheck -V v01 --input '{"userId":"abc"}'
pgfsmctl instance resume -q <instance-uuid>
pgfsmctl instance send   -q <instance-uuid> -e APPROVE --event-data '{"reason":"ok"}'
pgfsmctl instance stop   -q <instance-uuid>

ID=$(pgfsmctl instance create -n creditCheck -V v01 -o ids)
```

| Verb     | What it does                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| `create` | Creates the instance and its pgmq queue, sends the initial transition event, and enqueues it to `fsm_dispatch_queue` |
| `resume` | Re-enqueues an existing instance to `fsm_dispatch_queue`                                                             |
| `send`   | Sends an event to the instance's queue, with event logs                                                              |
| `stop`   | Sends a stop signal to the fsmlet worker running the instance, via `pg_notify`                                       |

`resume`, `send` and `stop` exit **`4`** when the instance doesn't exist.

| Flag            | Alias | Required by              | Description                                                   |
| --------------- | ----- | ------------------------ | ------------------------------------------------------------- |
| `--fsm-name`    | `-n`  | `create`                 | FSM definition name                                           |
| `--fsm-version` | `-V`  | `create`                 | FSM version                                                   |
| `--input`       |       | optional (`create`)      | Initial FSM context, JSON (xstate's `input`; was `--context`) |
| `--queue-name`  | `-q`  | `resume`, `send`, `stop` | FSM instance ID (a UUID; anything else exits `2`)             |
| `--event-type`  | `-e`  | `send`                   | Event type to send                                            |
| `--event-data`  |       | optional (`send`)        | Event payload, JSON                                           |
| `--db-url`      | `-d`  | optional                 | Postgres URL                                                  |
| `--profile`     |       | optional                 | Use this profile's `db_url`                                   |
| `--output`      | `-o`  | optional                 | `table`, `json` or `ids` (the instance UUID)                  |
| `--help`        | `-h`  |                          | Print help and exit                                           |

`instance` talks to the database directly through `@pgfsm/db` for now. SPEC-009
phase 2 moves it to the REST API with an operator key, keeping `--db-url` as
break-glass.

---

## `scheduler run` — fallback scheduler process

```bash
pgfsmctl scheduler run [-p <ms>] [-s <secs>]
```

pg_cron (`db cron register`) is the primary scheduler. This long-running process
is kept only as SPEC-003's fallback safety net until pg_cron is trusted as the
sole mechanism; running both is safe (`SELECT FOR UPDATE SKIP LOCKED`), just
redundant. It polls `fsm_core.schedule_next_pending()` and LISTENs on
`fsm_scheduler_work` (which nothing notifies since SPEC-003). Run it on the
control plane, not on fsmlet nodes. `Ctrl+C` / `SIGTERM` stop it gracefully; a
second `Ctrl+C` forces exit (`130`).

| Flag                       | Alias | Description                                                |
| -------------------------- | ----- | ---------------------------------------------------------- |
| `--poll-interval <ms>`     | `-p`  | Fallback poll interval in milliseconds (default: `30000`)  |
| `--stale-threshold <secs>` | `-s`  | Seconds before a fsmlet is considered dead (default: `30`) |
| `--db-url <url>`           | `-d`  | Postgres URL                                               |
| `--profile <name>`         |       | Use this profile's `db_url`                                |
| `--help`                   | `-h`  | Print help and exit                                        |

It holds a Pool of at most 4 connections (one dedicated LISTEN client).
`runFsmScheduler` is also exported from `@pgfsm/ctl` for callers that embed it
in-process (the fleet journey tests do).

---

## `config` — profiles

```bash
echo "$PGPASSWORD" | pgfsmctl config set prod \
    --db-url postgresql://fsm_admin_login@db.internal:5432/postgres --db-password-stdin
pgfsmctl config set prod --url https://pgfsm-api.internal   # API URL, for #473
pgfsmctl config use prod
pgfsmctl config list
pgfsmctl config show prod -o json
```

| Verb   | What it does                                                                            |
| ------ | --------------------------------------------------------------------------------------- |
| `set`  | Create or update a profile; only the given fields change. The first one becomes current |
| `use`  | Make a profile the current one (exit `4` if it doesn't exist)                           |
| `list` | Every profile; `*` marks the current one                                                |
| `show` | One profile (default: the current one); secrets show only as `set`                      |

Files live in `$PGFSM_CONFIG_DIR`, else the OS config directory plus `pgfsm`
(`$XDG_CONFIG_HOME` or `~/.config` on Linux, `~/Library/Application Support` on
macOS, `%APPDATA%` on Windows):

- `config.yaml`: profiles (`db_url`, `url`) and `current`. **No secrets.**
- `credentials.json`: per-profile `db_password` and `api_key`, mode `0600`.

Secrets are read from stdin (`--db-password-stdin`, `--api-key-stdin`), never
from arguments: a `--db-url` that contains a password is refused (exit `2`),
because it would land in shell history and the profile file.

---

## `completion`

```bash
source <(pgfsmctl completion bash)                       # ~/.bashrc
source <(pgfsmctl completion zsh)                        # ~/.zshrc
pgfsmctl completion fish > ~/.config/fish/completions/pgfsmctl.fish
```

Completes nouns, verbs (including `db cron <verb>`) and each noun's flags.

---

## HTTP API equivalents

The API server (`apps/fsm-core-ts-hono-deno`) exposes the same dispatch-model
operations over HTTP. They need an operator or admin key
(`Authorization: Bearer pgfsm_…`, SPEC-009 §3) unless the server runs with
`--no-auth`:

| HTTP route                  | `pgfsmctl` equivalent | Body                                                                                            |
| --------------------------- | --------------------- | ----------------------------------------------------------------------------------------------- |
| `POST /fsm`                 | `instance create`     | `{ fsm_name, fsm_version, fsm_context? }` — creates instance + enqueues to `fsm_dispatch_queue` |
| `POST /fsm/dispatch`        | `instance create`     | `{ fsm_name, fsm_version, fsm_context? }` — same dispatch-model creation, second route path     |
| `POST /fsm/resume-dispatch` | `instance resume`     | `{ queue }`                                                                                     |
| `POST /fsm/send`            | `instance send`       | `{ fsm_instance_id, event_data }`                                                               |
| `POST /fsm/stop`            | `instance stop`       | `{ queue }`                                                                                     |
| `POST /admin/fsm/load`      | `fsm load`            | `{ definitions: [{ fsmName, fsmVersion, fsmJson }] }` — admin key, `--enable-admin-api`         |

All of them need a scheduler (the pg_cron job, and optionally `scheduler run`)
and a running fsmlet to pick the work up.

---

## Exit codes

SPEC-009 §6 (dbosctl's table, plus `5`):

| Code  | Meaning                                                                                       |
| ----- | --------------------------------------------------------------------------------------------- |
| `0`   | Success (or `scheduler run` stopped cleanly)                                                  |
| `1`   | General error: database unreachable, an `fsm load` the database rejected, anything unexpected |
| `2`   | Usage: unknown noun/verb/option, missing or invalid arguments, bad `-o`, no database target   |
| `3`   | Authentication or authorization failed (SQLSTATE `42501` or `28xxx`)                          |
| `4`   | Not found: unknown instance or profile                                                        |
| `5`   | Check failed: a status command ran and found a problem (`db cron status` with no job)         |
| `130` | Interrupted (`Ctrl+C`)                                                                        |
