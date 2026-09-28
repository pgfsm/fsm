# pgfsmctl — CLI Usage Guide

`@pgfsm/ctl` ships one bin, `pgfsmctl`, for everything that operates on a
running pgfsm database (SPEC-005). Commands are `<noun> <verb>`:

| Command                                     | Kind     | Role                                                                                       | Replaces (`@pgfsm/sync-worker` ≤ 0.2) |
| ------------------------------------------- | -------- | ------------------------------------------------------------------------------------------ | ------------------------------------- |
| `pgcron register \| unregister \| status`   | one-shot | Manage the `pg_cron` job that drains the dispatch queue — the primary scheduler (SPEC-003) | `pgcron`                              |
| `instance create \| resume \| send \| stop` | one-shot | Instance control (kubectl equivalent) against the dispatch-queue model, straight to the DB | `fsmctl -c <command>`                 |
| `scheduler run`                             | long-run | The standing fsmscheduler process (kube-scheduler equivalent) — **fallback only**          | `fsmscheduler`                        |

No command needs a pgfsm project (`pgfsm.config.json`) — only a database.

> **`fsmlet`** (the kubelet-equivalent node agent) is not a `pgfsmctl` command:
> it runs your sync-operation code, so a project embeds it —
> `sync-worker/typescript/run-sync-worker.ts` calls `runFsmlet` from
> `@pgfsm/sync-worker`.

---

## Prerequisites and invocation

- **Database connection** — `-d/--db-url <url>`, else `DATABASE_URL` from the
  environment or a `.env` in the directory you run from.
- **Installed** (Node): `npx @pgfsm/ctl <noun> <verb> [options]` — the package
  has a single bin, so no `-p … --` form is needed. A pgfsm project pins it as
  `npm run db:pgcron`.
- **From this repo** (Deno, see `.prototools`): from `packages/fsm-ctl-ts/`,
  `deno task pgfsmctl <noun> <verb> [options]`; or from the repo root,
  `deno run --allow-all packages/fsm-ctl-ts/src/cli/pgfsmctl.ts …`.

Examples below use `pgfsmctl` for whichever of these you use.

`pgfsmctl --version` prints the bare version; `pgfsmctl --help` and
`pgfsmctl <noun> --help` print usage.

---

## `pgcron` — the pg_cron scheduler job

```bash
pgfsmctl pgcron register [-s <cron>]   # default schedule: "5 seconds"
pgfsmctl pgcron unregister
pgfsmctl pgcron status
```

`register` idempotently (re)registers the `fsm_schedule_all_pending` job, which
calls `fsm_core.schedule_all_pending()` on the schedule to drain
`fsm_dispatch_queue` (see `spec-003-pgcron-fsm-scheduler.md`). It unschedules
any existing job of that name first, so re-running it (e.g. to change the
schedule) is safe.

Neither `supabase db reset` (local dev) nor the applied `supabase/migrations/`
(production) register the job on their own: `cron.schedule()` is a data-level
side effect (a row in `cron.job`), which migra's structural diff can't capture.
Run `register` once after migrations apply, in every environment — in
Kubernetes, as a Job or init container.

`unregister` removes the job and succeeds whether or not it existed. `status`
prints the job (id, schedule, active, command) and exits `1` when none is
registered, so it doubles as a deploy check.

| Flag                | Alias | Description                                                         |
| ------------------- | ----- | ------------------------------------------------------------------- |
| `--schedule <cron>` | `-s`  | `pg_cron` schedule for `register` (default: `"5 seconds"`)          |
| `--db-url <url>`    | `-d`  | PostgreSQL connection string (overrides `DATABASE_URL` from `.env`) |
| `--help`            | `-h`  | Print help and exit                                                 |

---

## `instance` — FSM instance control

```bash
pgfsmctl instance create -n creditCheck -V v01
pgfsmctl instance create -n creditCheck -V v01 --context '{"userId":"abc"}'
pgfsmctl instance resume -q <instance-uuid>
pgfsmctl instance send   -q <instance-uuid> -e APPROVE --event-data '{"reason":"ok"}'
pgfsmctl instance stop   -q <instance-uuid>
```

| Verb     | What it does                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| `create` | Creates the instance and its pgmq queue, sends the initial transition event, and enqueues it to `fsm_dispatch_queue` |
| `resume` | Re-enqueues an existing instance to `fsm_dispatch_queue` (exit `1` if it doesn't exist)                              |
| `send`   | Sends an event to the instance's queue, with event logs (exit `1` if it doesn't exist)                               |
| `stop`   | Sends a stop signal to the fsmlet worker running the instance, via `pg_notify`                                       |

| Flag            | Alias | Required by              | Description                                                    |
| --------------- | ----- | ------------------------ | -------------------------------------------------------------- |
| `--fsm-name`    | `-n`  | `create`                 | FSM definition name                                            |
| `--fsm-version` | `-V`  | `create`                 | FSM version                                                    |
| `--context`     |       | optional (`create`)      | Initial FSM context, JSON string                               |
| `--queue-name`  | `-q`  | `resume`, `send`, `stop` | FSM instance ID (UUID)                                         |
| `--event-type`  | `-e`  | `send`                   | Event type to send                                             |
| `--event-data`  |       | optional (`send`)        | Event payload, JSON string                                     |
| `--db-url`      | `-d`  | optional                 | Database connection URL (overrides `DATABASE_URL` from `.env`) |
| `--help`        | `-h`  |                          | Print help and exit                                            |

`instance` talks to the database directly through `@pgfsm/db`, not to the REST
API. Routing it through the API (as `kubectl` goes through the apiserver) is
recorded as future work in SPEC-005.

---

## `scheduler run` — fallback scheduler process

```bash
pgfsmctl scheduler run [-p <ms>] [-s <secs>]
```

pg_cron (`pgcron register`) is the primary scheduler. This long-running process
is kept only as SPEC-003's fallback safety net until pg_cron is trusted as the
sole mechanism; running both is safe (`SELECT FOR UPDATE SKIP LOCKED`), just
redundant. It polls `fsm_core.schedule_next_pending()` and LISTENs on
`fsm_scheduler_work` (which nothing notifies since SPEC-003). Run it on the
control plane, not on fsmlet nodes. `Ctrl+C` / `SIGTERM` stop it gracefully; a
second `Ctrl+C` forces exit.

| Flag                       | Alias | Description                                                |
| -------------------------- | ----- | ---------------------------------------------------------- |
| `--poll-interval <ms>`     | `-p`  | Fallback poll interval in milliseconds (default: `30000`)  |
| `--stale-threshold <secs>` | `-s`  | Seconds before a fsmlet is considered dead (default: `30`) |
| `--db-url <url>`           | `-d`  | PostgreSQL connection string (overrides `DATABASE_URL`)    |
| `--help`                   | `-h`  | Print help and exit                                        |

It holds a Pool of at most 4 connections (one dedicated LISTEN client).
`runFsmScheduler` is also exported from `@pgfsm/ctl` for callers that embed it
in-process (the fleet journey tests do).

---

## HTTP API equivalents

The API server (`apps/fsm-core-ts-hono-deno`) exposes the same dispatch-model
operations over HTTP:

| HTTP route                  | `pgfsmctl` equivalent | Body                                                                                            |
| --------------------------- | --------------------- | ----------------------------------------------------------------------------------------------- |
| `POST /fsm`                 | `instance create`     | `{ fsm_name, fsm_version, fsm_context? }` — creates instance + enqueues to `fsm_dispatch_queue` |
| `POST /fsm/dispatch`        | `instance create`     | `{ fsm_name, fsm_version, fsm_context? }` — same dispatch-model creation, second route path     |
| `POST /fsm/resume-dispatch` | `instance resume`     | `{ queue }`                                                                                     |
| `POST /fsm/send`            | `instance send`       | `{ fsm_instance_id, event_data }`                                                               |
| `POST /fsm/stop`            | `instance stop`       | `{ queue }`                                                                                     |

All of them need a scheduler (the pg_cron job, and optionally `scheduler run`)
and a running fsmlet to pick the work up.

---

## Exit codes

| Code | Meaning                                                                                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Command completed (or `scheduler run` stopped cleanly)                                                                                   |
| `1`  | Unknown command/verb, missing or invalid arguments, no database URL, instance not found, `pgcron status` with no job, or a runtime error |
