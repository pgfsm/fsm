# @pgfsm/sync-worker

The out-of-band worker fleet that drives FSM instances forward — the HTTP API
never blocks on or owns worker lifecycle. Kubernetes-style split: `fsmlet`
(kubelet — long-running node agent) is routed work by `fsmscheduler`
(kube-scheduler — control plane, run once per cluster), driven one-shot by
`fsmctl`; `pgcron` is a one-shot deploy-time alternative to running a standing
`fsmscheduler`.

`fsmlet` has no CLI bin yet (removed for now — see this package's `CLAUDE.md`) —
embed `runFsmlet`/`startFsmlet` directly (see Programmatic usage below).

## Install

This package ships three CLI bins, so a plain `npx @pgfsm/sync-worker` can't
tell which one to run — pass `-p`/`--package` and name the bin after `--`:

```bash
npx -p @pgfsm/sync-worker -- fsmscheduler --help
```

or install it as a dependency / global CLI, after which each bin is callable
directly:

```bash
npm install @pgfsm/sync-worker
npm install -g @pgfsm/sync-worker   # for global fsmscheduler/fsmctl/pgcron commands
```

No Deno install is required to use the CLIs this way.

## Usage

Three CLIs ship in this package. Run any of them with `--help` for its full flag
reference. Examples below assume a global install (`fsmscheduler ...`); via
plain `npx` prefix each with `npx -p @pgfsm/sync-worker --`.

### `fsmscheduler` — control-plane router (kube-scheduler equivalent)

Run once per cluster, on the control plane alongside the API server — **not** on
`fsmlet` nodes. `pgcron` (below) is an alternative to running this as a standing
process.

**Input** — `-d`/`--db-url <url>` (falls back to `DATABASE_URL`, required).
`-p`/`--poll-interval <ms>`: fallback poll interval (default `30000`).
`-s`/`--stale-threshold <secs>`: seconds before an `fsmlet` is considered dead
(default `30`).

**Output/side effect** — starts a long-running process: listens on the
`fsm_scheduler_work` `pg_notify` channel; when a dispatch entry appears in
`fsm_dispatch_queue`, runs a scheduling cycle (`SELECT FOR UPDATE SKIP
LOCKED`,
filter+score active `fsmlet`s, mark `scheduled`, `pg_notify` the winning
`fsmlet`), plus a fallback poll for missed notifications.

```bash
fsmscheduler
fsmscheduler --poll-interval 10000 --stale-threshold 15
```

### `fsmctl` — one-shot control CLI (kubectl equivalent)

**Input** — `-c`/`--command <command>`, required: `create`, `resume`, `send`, or
`stop`.

- `create` — requires `-n`/`--fsm-name`, `-V`/`--fsm-version`; optional
  `--context <json>` (initial FSM context, default `{}`)
- `resume` / `stop` — require `-q`/`--queue-name <instance-id>`
- `send` — requires `-q`/`--queue-name` and `-e`/`--event-type`; optional
  `--event-data <json>` (default `{}`)

`-d`/`--db-url <url>` (falls back to `DATABASE_URL`) applies to all commands.

**Output/side effect** —

- `create`: creates a new FSM instance and its pgmq queue, enqueues it to
  `fsm_dispatch_queue`, and prints the created instance
- `resume`: re-enqueues an existing instance to `fsm_dispatch_queue`
- `send`: sends an event to a running instance's queue
- `stop`: sends a stop signal to the instance's worker via `pg_notify`

```bash
fsmctl -c create -n creditCheck -V 1
fsmctl -c create -n creditCheck -V 1 --context '{"userId":"abc"}'
fsmctl -c resume -q <instance-uuid>
fsmctl -c send -q <instance-uuid> -e APPROVE --event-data '{"reason":"ok"}'
fsmctl -c stop -q <instance-uuid>
```

### `pgcron` — one-shot deploy-time script

An **alternative** to running `fsmscheduler` as a standing process, not
something you also need to run alongside it.

**Input** — `-d`/`--db-url <url>` (falls back to `DATABASE_URL`, required).
`-s`/`--schedule <cron>`: pg_cron schedule expression (default `"5 seconds"`).

**Output/side effect** — idempotently (re)registers the
`fsm_schedule_all_pending` `pg_cron` job, which calls
`fsm_core.schedule_all_pending()` on the given schedule to drain the FSM
dispatch queue. Unschedules any pre-existing job with this name first, so it's
safe to re-run. Run once as a deploy-time step after applying migrations, or
whenever the schedule needs to change — `pg_cron`'s job registration is a
data-level side effect that a structural schema-diff migration can't capture.

```bash
pgcron
pgcron --schedule "10 seconds"
```

## Prerequisites

- **A Postgres database** — `DATABASE_URL`, or `--db-url`/`-d` passed to any CLI

## Programmatic usage

```typescript
import {
  runFsmlet, // node-agent implementation — no CLI bin yet, embed directly
  runFsmScheduler, // control-plane routing implementation behind fsmscheduler
  startFSMWorker, // drive a single FSM instance
  startFSMWorkerWithDBLock, // same, holding a DB-level advisory lock
} from "@pgfsm/sync-worker";

import type { FsmletOptions, FsmSchedulerOptions } from "@pgfsm/sync-worker";
```

## License

Apache-2.0
