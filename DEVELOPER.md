<h1 align="center">FSM Framework — Developer Guide</h1>

<p align="center">
  A framework for running versioned finite state machines inside PostgreSQL.
</p>

<p align="center">
  <a href="./CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs welcome"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0"></a>
</p>

> This is the **in-repo development guide** — every command below runs source
> straight out of this checkout with `deno run`, for anyone developing or
> debugging `fsm-compiler-ts`, `fsm-sync-worker-ts`, or
> `fsm-core-async-op-worker` themselves. If you just want to **use** the
> published `@pgfsm/*` packages to build your own FSM app, see the root
> [README.md](./README.md) instead — same lifecycle, `npx`-first.

This document is the lifecycle spec for an FSM — **design/generate** →
**scaffold** → **validate** → **run the cluster**.

```mermaid
flowchart LR
    A["<b>1. design / generate</b><br/>fsm.json"] --> B["<b>2. scaffold</b><br/>operation logic"]
    B --> C["<b>3. run Workers</b><br>3.a Sync Operation Worker <br>[ package : fsm-sync-worker-ts ]<br>( ctl  + scheduler + fsmlet ) <br>3.b Async Operation Worker <br>[ package : fsm-core-async-op-worker ]<br> ( ctl  + startActivityGatewayServer + Different lang ipc workers )"]
```

_Every step reads and writes through PostgreSQL as the source of truth._

---

## 1. Design or generate fsm.json

Sample fsm json

```jsonc
// fsm.json excerpt — one state using both kinds of operation logic
{
  "states": {
    "verifyingCredentials": {
      "entry": [{ "type": "logAttempt" }], // action — sync
      "invoke": [
        {
          // actor — async, driven by asyncOperationWorkerlet
          "type": "xstate.invoke",
          "id": "creditBureauCheck",
          "src": "checkBureau", // exported fn in <lang>/actors/checkBureau/checkBureau.<ext>
          "fsmType": "internalAsyncOperation", // internalAsyncOperation | sharedAsyncOperation | fsm
          "fsmVersion": "1",
          "fsmLanguage": "typescript" // the routing key for the polyglot model // typescript | python | rust | go | llm  (🔭 reserved)
        }
      ],
      "on": {
        "xstate.done.actor.creditBureauCheck": {
          "target": "checkingCreditScores",
          "guard": { "type": "isEligible" } // guard — sync
        }
      }
    }
  }
}
```

JSON Schema Reference:
[`packages/database-src/fsm.machine.schema.v3.json`](./packages/database-src/fsm.machine.schema.v3.json)

Format guide:
[`fsm-definition-format.md`](./packages/fsm-compiler-ts/docs/reference/fsm-definition-format.md).

Example :
[apps/fsm-core-example/fsm/creditCheck/v01/](./apps/fsm-core-example/fsm/creditCheck/v01/)

| Info    | Generate From an existing XState machine                                                                                                                                                                                                                                                                                                                                                                                    | Design From scratch                                                                                                                                                                   |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source  | An existing XState 5 `machine.ts`                                                                                                                                                                                                                                                                                                                                                                                           | No XState source — hand-author `fsm.json` directly against the schema                                                                                                                 |
| How     | Point the compiler at `machine.ts`; it emits `fsm.json` + `xstate-fsm.json`                                                                                                                                                                                                                                                                                                                                                 | Author states, transitions, and `invoke` objects by hand, then validate against the schema with any JSON Schema validator, e.g. [`ajv-cli`](https://github.com/ajv-validator/ajv-cli) |
| Command | `deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts -c generate-fsm-json -f apps/fsm-core-example/fsm/creditCheck/v01/machine.ts --output apps/fsm-core-example/fsm/creditCheck/v01`                                                                                                                                                                                                                            | `npx ajv-cli validate -s packages/database-src/fsm.machine.schema.v3.json -d apps/fsm-core-example/fsm/creditCheck/v01/fsm.json`                                                      |
| Steps   | 1. Export raw XState JSON → write `xstate-fsm.json`<br>2. Strip null entries from action arrays<br>3. Normalize string actions to `{ type }` objects<br>4. Set `actionName` from `delay` on raise/cancel actions<br>5. Fill in missing `fsmType`/`fsmVersion` on `invoke` (actor) entries<br>6. Write `fsm.json`<br>7. _(optional, `--show-recommendation`)_ validate `fsm.json` against the schema and log recommendations | None — you author `fsm.json` by hand, then run the `ajv-cli` command yourself                                                                                                         |
| Output  | `fsm.json` + `xstate-fsm.json`                                                                                                                                                                                                                                                                                                                                                                                              | `fsm.json`                                                                                                                                                                            |

---

## 2. Scaffold FSM operation

From a compiled `fsm.json`, generate **base (stub) code** for the two families
of operation logic a machine can reference:

1. **Async operation logic** — `actors`, via `invoke` objects
2. **Sync operation logic** — `actions`, `guards`, `delays`

Both are driven by the same compiler CLI; they differ in command, language
routing, and where the resulting code runs.

| Info                | Async Operation                                                                                                                                                                 | Sync Operation                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FSM component       | `actors` (the `invoke` objects on a state)                                                                                                                                      | `actions`, `guards`, `delays`                                                                                                                                            |
| PRD                 | [PRD-002](./packages/fsm-compiler-ts/docs/prd/prd-002-scaffold-async-operation-logic.md)                                                                                        | [PRD-003](./packages/fsm-compiler-ts/docs/prd/prd-003-scaffold-sync-operation-logic.md)                                                                                  |
| Execution model     | Long-running; each runs in its own queue and process, driven by the `asyncOperationWorkerlet`; reports back via `xstate.done.actor.<id>` / `xstate.error.actor.<id>` events     | Pure/inline; runs inside a single macrostep of the `fsmlet` — no separate process                                                                                        |
| CLI command         | `generate-async-logic`                                                                                                                                                          | `generate-sync-logic`                                                                                                                                                    |
| Command             | `deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts -c generate-async-logic -f apps/fsm-core-example/fsm`                                                           | `deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts -c generate-sync-logic -f apps/fsm-core-example/fsm`                                                     |
| Language selection  | Per-invoke, from that invoke object's `fsmLanguage` field — a single machine can spread its actors across runtimes                                                              | Via `--lang` flag, applied uniformly to the whole generation run; default (and currently only accepted value) `typescript`                                               |
| Languages generated | It will generate code for all 4 languages, one invoke at a time, according to each invoke's `fsmLanguage`                                                                       | It will generate TS stubs only — `--lang` with any value other than `typescript` is rejected                                                                             |
| Supported languages | `typescript`, `python`, `rust`, `go` — unsupported `fsmLanguage` values are skipped with a warning                                                                              | `typescript` only (`python`/`rust`/`go` are members of `OperationLang` but not yet maintained/tested for this command, so the CLI rejects them)                          |
| File naming         | One file per invoke, in its own subfolder: `<src>/<src>.<ext>` (exports one function named after the actor `src`)                                                               | One stub per `action` / `guard` / `delay` referenced in `fsm.json`                                                                                                       |
| Output layout       | `<fsmLanguage>/actors/<src>/<src>.<ext>`                                                                                                                                        | `sync-worker/<lang>/actions/<index>`, `sync-worker/<lang>/guards/<index>`, `sync-worker/<lang>/delays/<index>`                                                           |
| Planned gaps        | Generated actor stub signature doesn't yet match the worker's `(input) => Promise<output>` calling convention; external actors are still stubbed locally rather than referenced | Action stubs are emitted as `(context, event)` and guard stubs as `(context, event)`, but the worker invokes them as `(context, params, meta)` / `(context, cond, meta)` |

See the compiler [TODO](./packages/fsm-compiler-ts/docs/todo/TODO.md) for both
planned-gap items.

Both `generate-sync-logic` and `generate-async-logic`'s `-f`/`--folder` also
accept a single `fsm.json` file (instead of only a plugin-root directory), in
which case `-o`/`--output` is required — a relative or absolute path naming the
version folder to scaffold stubs into, resolved independently of where the
`fsm.json` itself lives. `generate-async-logic` additionally refreshes the
aggregate registry/worker SDK (`worker-sdk-generated/<lang>/`, see the table
above) in both `-f`/`--folder` shapes, not just directory mode — there's no
separate flag for where that lands: one level above `-f`/`--folder` (the app
root) in directory mode, or into `-o`/`--output` in single-`fsm.json` mode.
`generate-all` runs `generate-fsm-json`, then `generate-async-logic`, then
`generate-sync-logic` in one invocation instead of three. See
[`cli-usage.md`](./packages/fsm-compiler-ts/docs/guides/cli-usage.md) for
details and examples.

### Async operation logic — example layout

```
creditCheck/v01/
  typescript/actors/checkBureau/checkBureau.ts         # fsmLanguage: "typescript"
  python/actors/checkBureau/checkBureau.py             # fsmLanguage: "python"
  rust/actors/checkBureau/checkBureau.rs               # fsmLanguage: "rust"
  go/actors/checkReportsTable/checkReportsTable.go     # fsmLanguage: "go"
```

### Sync operation logic — example layout

```
<lang>/
  actions/<index>   # side effects
  guards/<index>    # transition predicates (return boolean)
  delays/<index>    # delay durations (return ms)
```

Fill in the sync stubs, then validate exports without touching the database:

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-sync-operation \
  -f apps/fsm-core-example/fsm \
  -w fsm
```

---

## 3. Start the workers

The FSM side runs as a **node agent** (kubelet equivalent) — it validates, loads
its modules, and registers itself, then waits for its companion **scheduler**
(kube-scheduler equivalent, a separate control-plane process — see
[section 4](#4-start-the-schedulers)) to route claimed work to it via
`pg_notify`.

The async-operation side does **not** follow that kube-style node-agent /
scheduler split. It runs as a single long-running
**`startActivityGatewayServer`** process (`fsm-core-async-op-worker`) that
starts a sidecar Unix socket for the per-language **lang ipc workers** to
register their actors against, then polls Postgres directly on its own interval
to claim and dispatch work — no separate scheduler process, no `pg_notify`.

The gateway's client-facing gRPC contract
(`packages/fsm-proto-codegen/proto/fsm-core-async-op-worker/pgfsm/activitygateway/v1/activity_gateway.proto`)
is compiled to real TypeScript/Python/Rust/Go stubs by
[`fsm-proto-codegen`](./packages/fsm-proto-codegen/) via `buf generate`,
committed under `packages/fsm-proto-codegen/gen/<lang>/` — not loaded from the
`.proto` file at runtime. Regenerate after changing the contract; see that
package's [README](./packages/fsm-proto-codegen/README.md) for the per-language
plugin setup.

| Info                        | FSM Async-Operation Worker — `fsm-core-async-op-worker` (current)                                                                                                                                                                                                       | FSM Sync-Operation Worker                                                                                                                                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drives                      | Async operation logic (`actors`) — dispatches to already-running per-language worker-sdk processes over the sidecar socket, one fire-and-forget dispatch per claimed event (no long-running in-process worker per queue)                                                | State machines — sync operation logic, transitions, and dispatching invokes                                                                                                                                                                              |
| Runtime language            | Polyglot (multi-language) — driven by `fsmLanguage` (`typescript`/`python`/`go`/`rust`), always dispatched over the sidecar socket, never in-process                                                                                                                    | TypeScript only                                                                                                                                                                                                                                          |
| Behaviour                   | Runtime dispatch only — the gateway never imports or loads actor code itself; each language's worker-sdk process (run separately) owns its own module loading                                                                                                           | Runtime — TypeScript only, and TypeScript supports dynamic import                                                                                                                                                                                        |
| Worker Arch components      | `SidecarGateway` (registration + dispatch), per-language **lang ipc workers** (worker-sdk processes)                                                                                                                                                                    | `fsmlet` (kubelet), `fsm Scheduler` (kube Scheduler), `fsmctl` (kubectl)                                                                                                                                                                                 |
| Worker Arch ADR             | [ADR-003](./docs/adr/adr-003-fsm-async-operation-polyglot-actor-execution-model.md)                                                                                                                                                                                     | [ADR-002](./docs/adr/adr-002-fsm-sync-operation-worker-execution-model.md)                                                                                                                                                                               |
| CLI entry point             | `packages/fsm-core-async-op-worker/src/cli/async-operation-worker-gateway.ts`                                                                                                                                                                                           | `packages/fsm-sync-worker-ts/src/cli/fsmlet.ts`                                                                                                                                                                                                          |
| On startup, validates       | None — the gateway itself validates nothing; each per-language worker-sdk process starts, loads/validates its own actor modules, and self-registers over the sidecar socket                                                                                             | `validateSyncOperationFromFolders` — TypeScript only, workflow type hardcoded to `"fsm"`                                                                                                                                                                 |
| Cross-checks the other side | Not required — doesn't follow `validateAsyncOperationFromFolders`, follows the lang IPC worker path instead                                                                                                                                                             | `validateSyncOperationFromFolders` using the parameter passed from `fsmlet` via the `asyncOperationVerificationMode` argument (`checkRegistry` / `checkRegistryAndWorking`, via `checkRegistryForAsyncActors` / `checkRegistryAndWorkingForAsyncActors`) |
| On startup, loads           | Nothing from folders — the gateway itself just starts the sidecar (and, unless `--disable-poll-loop`, the poll loop) and waits; each per-language worker-sdk process loads/validates its own actor modules and self-registers over the sidecar socket                   | `fsm.json` into PostgreSQL via `loadFsmFromJson` → `load_fsm_from_json_v2`                                                                                                                                                                               |
| Registers itself in         | In-memory only, no DB table — `SidecarGateway.actorRoutes` (per-worker `register` `WireEnvelope` over `--sidecar-socket`). Optional `--ensure-queue-on-register` also ensures a PGMQ queue per registered actor via `ensure_async_operation_queue_for_worker_v2`        | `fsm_workerlet` table (`fsm_modules`, `max_concurrency`)                                                                                                                                                                                                 |
| Listens on                  | `--sidecar-socket` (Unix socket, worker register/invoke_result/invoke_error frames) — no `pg_notify` channel; the poll loop pulls from Postgres itself every `--poll-interval-ms` (default 30s)                                                                         | `fsm_fsmlet_work_<id>` and `fsm_worker_stop` (per-instance abort)                                                                                                                                                                                        |
| Claims work via             | `claimPendingAsyncOperationEventsForWorkers` → `claim_pending_async_operation_events_for_workers_v2()`, called proactively by the poll loop every `--poll-interval-ms` (default 30s) — not triggered by `pg_notify`                                                     | `claim_scheduled_for_fsmlet()`                                                                                                                                                                                                                           |
| Concurrency model           | Fire-and-forget per claimed event — no semaphore/`--max-concurrency` in this package. Each event dispatches via `sidecar.invoke()` over the socket to the already-running worker-sdk process for that actor, which owns its own concurrency                             | One FSM worker per claimed instance, bounded by `--max-concurrency` semaphore                                                                                                                                                                            |
| Heartbeat                   | Not implemented — `heartbeat` is a reserved `WireType` in the sidecar protocol, but nothing sends or tracks one yet                                                                                                                                                     | `fsmletHeartbeat` every 5s (tracks `active_workers`), 30s fallback poll                                                                                                                                                                                  |
| Graceful shutdown           | `SIGINT`/`SIGTERM` aborts the poll loop (`AbortSignal`), stops accepting new gRPC connections, closes the sidecar/Unix socket, closes the DB pool if it was opened; no DB deregistration (nothing was registered in a DB table to begin with); Ctrl+C twice force-exits | `SIGINT`/`SIGTERM` aborts active workers, drains, deregisters from `fsm_workerlet`                                                                                                                                                                       |

> `fsm-async-worker-ts`, the previous async-operation worker, followed a
> different node-agent/scheduler split and used different registries entirely
> (`async_operation_meta`, `async_operation_workerlet`). It's superseded — kept
> runnable, but no new work should target it. Full comparison and commands:
> [Appendix: superseded `fsm-async-worker-ts`](#appendix-superseded-fsm-async-worker-ts).

### Start the async-operation worker

```bash
# Sidecar (worker registration) + gRPC/Connect gateway + 30s poll loop —
# standalone: no companion scheduler process, no pg_notify
deno run --allow-all packages/fsm-core-async-op-worker/src/cli/async-operation-worker-gateway.ts \
  --bind unix:/tmp/pgfsm-activity-gateway.sock \
  --sidecar-socket /tmp/pgfsm-activity-gateway-workers.sock \
  --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  --poll-interval-ms 30000
  # --disable-poll-loop        # gateway/sidecar only, no DB connection needed
  # --ensure-queue-on-register # auto-create a PGMQ queue for every newly registered actor
```

Needs at least one per-language worker-sdk process to connect to
`--sidecar-socket` and register its actors — see
[`CLI-USAGE.md`](./packages/fsm-core-async-op-worker/docs/guides/CLI-USAGE.md)
for the full flag reference, startup sequence, and PGMQ message payload shape.

### Start the worker SDK itself

One process per language that has actors, generated by `fsm-compiler-ts`'s
`generate-async-logic` command into
`apps/fsm-core-example/worker-sdk-generated/<lang>/` (run that command first if
the directory doesn't exist yet — `-f apps/fsm-core-example/fsm` is enough; the
command writes the aggregate one level above `--folder`, i.e. the **app root**,
automatically; see above). Each connects to the gateway's `--sidecar-socket`
above and serves invocations for every actor compiled into its registry until
stopped.

Each of these is a **long-running foreground process** (it serves invocations
until stopped) — run one at a time, each in its own fresh terminal at the repo
root. Don't paste multiple blocks into the same shell session: several of them
`cd` and rely on starting from the repo root, so a leftover `cd` from a previous
block breaks the next one's relative paths.

```bash
# TypeScript — runs from the repo root as-is (Deno resolves imports against
# the module's own path, not cwd)
deno run --allow-all apps/fsm-core-example/worker-sdk-generated/typescript/cli.ts start \
  --gateway-socket /tmp/pgfsm-activity-gateway-workers.sock
```

```bash
# Python — must run from inside its own directory, for both steps: pip (and
# uv) resolve a relative editable path inside requirements.txt against cwd,
# not the file's own location, so `pip install -r <path>` from elsewhere
# silently resolves the fsm-proto-codegen editable dependency to the wrong
# place. Also install via `python3 -m pip`, not a bare `pip` — on a machine
# with more than one Python (proto/pyenv/homebrew/etc. alongside the system
# one), bare `pip` can silently resolve to a *different* interpreter than
# `python3` below, so the install lands somewhere `python3 cli.py` never
# looks (surfaces as `ModuleNotFoundError: No module named 'pgfsm'`).
# `python3 -m pip` always installs into the same interpreter running it.
cd apps/fsm-core-example/worker-sdk-generated/python
python3 -m pip install -r requirements.txt
python3 cli.py start --gateway-socket /tmp/pgfsm-activity-gateway-workers.sock
```

```bash
# Go — must run from inside its own directory (go.mod's replace directives
# are relative to it; `go run <path>` from elsewhere doesn't resolve them).
# No list/start subcommand — it always prints its registry, then connects.
cd apps/fsm-core-example/worker-sdk-generated/go
go run . --gateway-socket /tmp/pgfsm-activity-gateway-workers.sock
```

```bash
# Rust — same directory requirement as Go (Cargo resolves against the
# nearest Cargo.toml). No subcommand either.
cd apps/fsm-core-example/worker-sdk-generated/rust
cargo run --release -- --gateway-socket /tmp/pgfsm-activity-gateway-workers.sock
```

`list` (TypeScript/Python only) prints the actors compiled into that process's
registry without connecting to the gateway — useful to sanity-check a generated
registry before wiring up the real socket.

### Start the FSM worker

```bash
# Node agent — validates, loads fsm.json, registers, then waits for work
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/fsmlet.ts \
  -f /abs/path/to/apps/fsm-core-example/fsm \
  -m 8                     # max FSM instances driven concurrently (default 8)
  # -i <fsmlet-id>         # stable identity (default: random UUID per startup)
  # -d <db-url>            # overrides DATABASE_URL
```

This node agent needs its companion **FSM scheduler** running somewhere in the
cluster to ever receive claimed work — see [section 4](#4-start-the-schedulers).
See [`CLI-USAGE.md`](./packages/fsm-sync-worker-ts/docs/guides/CLI-USAGE.md)
(fsmlet) for the full flag reference and startup sequence.

---

## 4. Start the schedulers

The FSM Sync-Operation Worker has a companion **scheduler** — a control-plane
routing process (kube-scheduler equivalent) run once per cluster, never on a
worker node. It listens for a `pg_notify` wake-up, then loops a single PG
function that atomically claims the next pending dispatch entry, filters/scores
active `fsmlet`s, assigns the winner, and notifies it — repeating until the
queue is empty or no `fsmlet` has capacity. A fallback poll catches any
notification missed after a `LISTEN` connection drop.

`fsm-core-async-op-worker` (the current async-operation worker) has **no
scheduler** — it polls Postgres directly on its own interval instead (see
[section 3](#3-start-the-workers)). The Async-Operation Scheduler belonged to
the superseded `fsm-async-worker-ts` node-agent/scheduler split; see
[Appendix: superseded `fsm-async-worker-ts`](#appendix-superseded-fsm-async-worker-ts)
if you're still running that older worker.

| Info                    | FSM Scheduler                                                                |
| ----------------------- | ---------------------------------------------------------------------------- |
| CLI                     | `packages/fsm-sync-worker-ts/src/cli/fsmscheduler.ts`                        |
| Routes work for         | `fsmlet` node agents                                                         |
| Listens on              | `fsm_scheduler_work`                                                         |
| Dispatch table          | `fsm_dispatch_queue`                                                         |
| Scheduling function     | `schedule_next_pending()`                                                    |
| Notifies the winner via | `fsm_fsmlet_work_<id>` (channel the fsmlet is listening on — see section 3)  |
| `--stale-threshold`     | Seconds before a fsmlet with no heartbeat is treated as dead (default `30`)  |
| `--poll-interval`       | Fallback poll interval in ms, catches missed notifications (default `30000`) |
| Deployment              | Control plane, alongside the API server — **not** on worker nodes            |

### Start the FSM scheduler

```bash
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/fsmscheduler.ts
  # -d <db-url>             # overrides DATABASE_URL
  # -p <poll-interval-ms>   # fallback poll interval (default 30000)
  # -s <stale-threshold-s>  # seconds before a fsmlet is considered dead (default 30)
```

### Alternative: `pg_cron` instead of a standing scheduler process

If you'd rather not run `fsmscheduler` as a standing process at all, `pgcron` is
a one-shot CLI that registers a `pg_cron` job to do the same scheduling work —
`schedule_next_pending()` in a loop — on a periodic in-database timer instead of
a `LISTEN`/poll loop. See
[`docs/specs/spec-003-pgcron-fsm-scheduler.md`](docs/specs/spec-003-pgcron-fsm-scheduler.md).

```bash
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/pgcron.ts
  # -d <db-url>    # overrides DATABASE_URL
  # -s <schedule>  # pg_cron schedule expression (default "5 seconds")
```

Run it once to register (or update) the job — it doesn't run as a standing
process itself, it just calls PostgreSQL's `cron.schedule()` and exits.

> **Optional:** with `pg_cron` handling scheduling, the standing `fsmscheduler`
> CLI is no longer needed. If you want to fully retire it, also remove the
> `PERFORM pg_notify('fsm_scheduler_work', input_instance_id::text);` call from
> `fsm_core.enqueue_fsm_dispatch_v2` (defined in
> `packages/database-src/supabase/schemas/35_fsm_sync_operation_worker_v1/20250119124637_fsm_scheduler_dispatch.sql`)
> — that notify is what wakes `fsmscheduler`'s `LISTEN` connection, so removing
> it breaks that link. Only do this once you've confirmed the `pg_cron` job is
> registered and running; otherwise dispatch entries will have no scheduling
> trigger at all.

---

## 5. Control the cluster (`ctl`)

Each dispatch model has a one-shot **control CLI** (kubectl equivalent) — unlike
the node agents and schedulers in sections 3–4, these issue a single command
against PostgreSQL (or, for the async-operation gateway, the gateway's gRPC API)
and exit; they don't validate, register, or listen for work.

| Info           | `fsmctl`                                                                                                           | `async-operation-worker-gateway-ctl`                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controls       | FSM instances — the dispatch-queue model driven by the `fsmscheduler`/`fsmlet` pair                                | A running `fsm-core-async-op-worker` gateway, over its gRPC/Connect API                                                                                                                             |
| CLI            | `packages/fsm-sync-worker-ts/src/cli/fsmctl.ts`                                                                    | `packages/fsm-core-async-op-worker/src/cli/async-operation-worker-gateway-ctl.ts`                                                                                                                   |
| Commands       | `create`, `resume`, `send`, `stop`                                                                                 | `list`, `invoke`                                                                                                                                                                                    |
| `create`       | Creates a new FSM instance, its pgmq queue, sends `initialTransition_event`, and enqueues to `fsm_dispatch_queue`  | — (no equivalent — instances/dispatch aren't this ctl's concern)                                                                                                                                    |
| `resume`       | Re-enqueues an existing FSM instance to the `fsmscheduler` via `resumeEventForFsmWorker`                           | — (no equivalent)                                                                                                                                                                                   |
| `send`         | Sends an event to a running FSM instance via `sendEventToFsmQueueWithEventLogs`                                    | — (no equivalent)                                                                                                                                                                                   |
| `stop`         | Sends a stop signal to a running `fsmlet` worker via `pg_notify` (`stopFSMWorker`)                                 | — (no equivalent)                                                                                                                                                                                   |
| `list`         | — (no equivalent)                                                                                                  | Calls `ListRegisteredActors` and prints the actor keys currently registered with the gateway                                                                                                        |
| `invoke`       | — (no equivalent)                                                                                                  | Calls `Invoke` for a given actor identity against the gateway and prints the result — debug/test only                                                                                               |
| Required flags | `-c/--command`, plus per-command: `create` needs `-n/-v`; `resume`/`send`/`stop` need `-q`; `send` also needs `-e` | none for `list`; `invoke` needs `--parent-fsm-name`, `--parent-fsm-version`, `--async-operation-type`, `--async-operation-name`, `--async-operation-version`, `--async-operation-language`          |
| Depends on     | `fsmscheduler` + `fsmlet` running to pick up the dispatched/resumed/sent work                                      | A running `async-operation-worker-gateway` process (`--target`, default `unix:/tmp/pgfsm-activity-gateway.sock`) — talks only to the gateway, never touches Postgres or the sidecar socket directly |

```bash
# fsmctl
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/fsmctl.ts -c create -n creditCheck -v 1
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/fsmctl.ts -c resume -q <instance-uuid>
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/fsmctl.ts -c send -q <instance-uuid> -e APPROVE
deno run --allow-all packages/fsm-sync-worker-ts/src/cli/fsmctl.ts -c stop -q <instance-uuid>

# async-operation-worker-gateway-ctl
deno run --allow-all packages/fsm-core-async-op-worker/src/cli/async-operation-worker-gateway-ctl.ts list
deno run --allow-all packages/fsm-core-async-op-worker/src/cli/async-operation-worker-gateway-ctl.ts invoke \
  --parent-fsm-name creditCheck --parent-fsm-version v01 \
  --async-operation-type internalAsyncOperation --async-operation-name checkBureau --async-operation-version v01 \
  --async-operation-language typescript \
  --input '{"ssn":"123"}'
```

See [`CLI-USAGE.md`](./packages/fsm-sync-worker-ts/docs/guides/CLI-USAGE.md)
(fsmctl) and
[`CLI-USAGE.md`](./packages/fsm-core-async-op-worker/docs/guides/CLI-USAGE.md)
(async-operation-worker-gateway-ctl) for the full flag reference. The old
`async-operation-ctl` (for `fsm-async-worker-ts`) is covered in
[Appendix: superseded `fsm-async-worker-ts`](#appendix-superseded-fsm-async-worker-ts).

---

## Appendix: superseded `fsm-async-worker-ts`

`fsm-async-worker-ts` was the original async-operation worker. It's superseded
by `fsm-core-async-op-worker` (sections
[3](#3-start-the-workers)–[5](#5-control-the-cluster-ctl) above) — kept runnable
for now, but no new work should target it. Unlike the current gateway, it
followed the same kube-style node-agent/scheduler split as the FSM
Sync-Operation Worker, and registered itself in its own DB tables
(`async_operation_meta`, `async_operation_workerlet`) rather than in-memory over
a sidecar socket.

| Info                        | FSM Async-Operation Worker — `fsm-async-worker-ts` (old)                                                                                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drives                      | Async operation logic (`actors`) — one long-running async-operation worker per actor queue                                                                                                                                                                                    |
| Runtime language            | Polyglot (multi-language) — driven by `fsmLanguage` (`typescript`/`python`/`go`/`rust`)                                                                                                                                                                                       |
| Behaviour                   | Runtime + Compile-time — Go and Rust don't support dynamic import, so actor modules are resolved ahead of time rather than loaded dynamically                                                                                                                                 |
| Worker Arch components      | `lang ipc workers`, `ipc worker gateway multi queue poller`                                                                                                                                                                                                                   |
| Worker Arch ADR             | [ADR-003](./docs/adr/adr-003-fsm-async-operation-polyglot-actor-execution-model.md)                                                                                                                                                                                           |
| CLI entry point             | `packages/fsm-async-worker-ts/src/cli/async-operation-workerlet.ts`                                                                                                                                                                                                           |
| On startup, validates       | None — compile-time model follows a different approach: each lang IPC worker starts and registers its fns with the IPC lang worker gateway, which updates PostgreSQL                                                                                                          |
| Cross-checks the other side | Not required — doesn't follow `validateAsyncOperationFromFolders`, follows the lang IPC worker path instead                                                                                                                                                                   |
| On startup, loads           | Each verified actor into `async_operation_meta` via `load_async_operation_meta_v2` (Note: this may change)                                                                                                                                                                    |
| Registers itself in         | `async_operation_workerlet` table (`supported_async_operations`, `max_pid_number`) (Note: this may change)                                                                                                                                                                    |
| Listens on                  | `async_op_workerlet_work_<id>` (Note: this may change)                                                                                                                                                                                                                        |
| Claims work via             | `claim_scheduled_for_async_operation_workerlet()` (Note: this may change)                                                                                                                                                                                                     |
| Concurrency model           | One long-running worker per unique actor queue, bounded by `--max-concurrency` semaphore. TypeScript runs in-process (`startFSMAsyncOperationWorker`); Python spawns a subprocess; Go/Rust actors validate but log a warning and are not yet runnable (Note: this may change) |
| Heartbeat                   | `asyncOperationWorkerletHeartbeat` every 5s (tracks `active_pid_number`), 30s fallback poll                                                                                                                                                                                   |
| Graceful shutdown           | `SIGINT`/`SIGTERM` aborts active queue-workers, drains, deregisters from `async_operation_workerlet`                                                                                                                                                                          |

```bash
# Node agent — validates, loads actor metadata, registers, then waits for work
deno run --allow-all packages/fsm-async-worker-ts/src/cli/async-operation-workerlet.ts \
  -f /abs/path/to/apps/fsm-core-example/fsm \
  -l typescript,python     # runtime languages to validate/activate (required)
  -t internalAsyncOperation  # workflow type: internalAsyncOperation | sharedAsyncOperation (default internalAsyncOperation)
  -m 8                      # max concurrent queue-workers (default 8)
  # -i <workerlet-id>       # stable identity (default: random UUID per startup)
  # -d <db-url>             # overrides DATABASE_URL
```

This node agent needs its companion **async-operation scheduler** running
somewhere in the cluster to ever receive claimed work. See
[`CLI-USAGE.md`](./packages/fsm-async-worker-ts/docs/guides/CLI-USAGE.md) for
the full flag reference and startup sequence.

### Async-operation scheduler (old)

| Info                    | Async-Operation Scheduler                                                      |
| ----------------------- | ------------------------------------------------------------------------------ |
| CLI                     | `packages/fsm-async-worker-ts/src/cli/async-operation-scheduler.ts`            |
| Routes work for         | `asyncOperationWorkerlet` node agents                                          |
| Listens on              | `async_operation_scheduler_work`                                               |
| Dispatch table          | `async_operation_instance_and_async_operation_workerlet`                       |
| Scheduling function     | `async_operation_schedule_next_pending()`                                      |
| Notifies the winner via | `async_op_workerlet_work_<id>` (channel the workerlet is listening on)         |
| `--stale-threshold`     | Seconds before a workerlet with no heartbeat is treated as dead (default `30`) |
| `--poll-interval`       | Fallback poll interval in ms, catches missed notifications (default `30000`)   |
| Deployment              | Control plane, alongside the API server — **not** on worker nodes              |

```bash
deno run --allow-all packages/fsm-async-worker-ts/src/cli/async-operation-scheduler.ts
  # -d <db-url>             # overrides DATABASE_URL
  # -p <poll-interval-ms>   # fallback poll interval (default 30000)
  # -s <stale-threshold-s>  # seconds before a workerlet is considered dead (default 30)
```

### `async-operation-ctl` (old)

| Info             | `async-operation-ctl`                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controls         | Async-operation instances — the dispatch tables driven by the async-operation scheduler/workerlet pair                                                      |
| CLI              | `packages/fsm-async-worker-ts/src/cli/async-operation-ctl.ts`                                                                                               |
| Commands         | `list-instances`, `list-meta`, `dispatch`                                                                                                                   |
| `dispatch`       | Creates a new async-operation instance and calls `createAsyncOperationInstanceAndNotifyAsyncOperationSchedulerWork` to notify the async-operation scheduler |
| `list-instances` | Lists `async_operation_instance_and_async_operation_workerlet` rows via `listAsyncOperationInstances`                                                       |
| `list-meta`      | Lists `async_operation_meta` rows (the actor registry) via `listAsyncOperationMeta`                                                                         |
| Required flags   | `-c/--command`, plus for `dispatch`: `-n/-v/-t`, `--parent-fsm-name`, `--parent-fsm-version`, `-l`                                                          |
| Depends on       | async-operation scheduler + `asyncOperationWorkerlet` running to pick up dispatched work                                                                    |

```bash
deno run --allow-all packages/fsm-async-worker-ts/src/cli/async-operation-ctl.ts -c list-instances
deno run --allow-all packages/fsm-async-worker-ts/src/cli/async-operation-ctl.ts -c list-meta
deno run --allow-all packages/fsm-async-worker-ts/src/cli/async-operation-ctl.ts -c dispatch \
  -n checkBureau -v 1 -t internalAsyncOperation \
  --parent-fsm-name creditCheck --parent-fsm-version 1 \
  -l typescript
```

See [`CLI-USAGE.md`](./packages/fsm-async-worker-ts/docs/guides/CLI-USAGE.md)
for the full flag reference.

---

## Appendix: Maps to today's code

Rows marked 🗄️ describe the superseded `fsm-async-worker-ts` path (see
[Appendix: superseded `fsm-async-worker-ts`](#appendix-superseded-fsm-async-worker-ts))
— kept for historical mapping, not current guidance. The current async-operation
worker's terms are the `fsm-core-async-op-worker` rows further down.

| Design term (this spec)                                  | Today's implementation                                                                                                                                                                                | Status                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `asyncOperationWorkerlet`                                | `packages/fsm-async-worker-ts/src/asyncOperationWorkerlet/asyncOperationWorkerlet.ts`, CLI `async-operation-workerlet.ts`                                                                             | 🗄️ Superseded                                                   |
| `async_operation_meta` (actor registry)                  | `async_operation_meta` table, loaded via `loadAsyncOperation` → `load_async_operation_meta_v2`                                                                                                        | 🗄️ Superseded                                                   |
| `async_operation_workerlet` (node registry)              | `async_operation_workerlet` table — `registerAsyncOperationWorkerlet` / `asyncOperationWorkerletHeartbeat` / `deregisterAsyncOperationWorkerlet`                                                      | 🗄️ Superseded                                                   |
| scheduler / dispatch (async operation)                   | `async-operation-scheduler.ts`, `async_operation_schedule_next_pending`, `createAsyncOperationInstanceAndNotifyAsyncOperationSchedulerWork`, `async_operation_instance_and_async_operation_workerlet` | 🗄️ Superseded                                                   |
| `async-operation-ctl` (control CLI)                      | `packages/fsm-async-worker-ts/src/cli/async-operation-ctl.ts` — `list-instances` / `list-meta` / `dispatch`                                                                                           | 🗄️ Superseded                                                   |
| `SidecarGateway` (actor routing)                         | `packages/fsm-core-async-op-worker/src/sidecar/gateway.ts` — in-memory `actorRoutes`, no DB table; registration over `--sidecar-socket`                                                               | ✅ Shipped                                                      |
| gateway wire protocol (buf-codegenned)                   | `packages/fsm-proto-codegen/` (`buf generate`) → `gen/{typescript,python,rust,go}/`, wired into `gatewayClient.ts`/`gatewayServer.ts`                                                                 | ✅ Shipped                                                      |
| `async-operation-worker-gateway-ctl` (control/debug CLI) | `packages/fsm-core-async-op-worker/src/cli/async-operation-worker-gateway-ctl.ts` — `list` / `invoke`                                                                                                 | ✅ Shipped                                                      |
| `lang` arg / `fsmLanguage` routing                       | `generate-sync-logic --lang` (typescript only currently); `generate-async-logic` (by `fsmLanguage`, ts/python/rust/go); `validate-async-operation --lang` (ts/python/rust/go)                         | ✅ Shipped (scaffold/validate) — 🔭 Planned (Go/Rust execution) |
| async op scaffolding (`actors/`)                         | `generate-async-logic` command (`generate-async-operation-logic.ts`)                                                                                                                                  | ✅ Shipped                                                      |
| sync op scaffolding (actions/…)                          | `generate-sync-logic --lang` command (`generate-sync-operation-logic.ts`)                                                                                                                             | ✅ Shipped                                                      |
| validate `fsm.json` + operation logic                    | `validate-sync-operation-logic.ts`, `validate-async-operation-logic-v2.ts`                                                                                                                            | ✅ Shipped                                                      |
| load `fsm.json`                                          | `load-fsm-json.ts` (`loadFsmJSONFromFolders`); `loadFsmFromJson` → `load_fsm_from_json_v2`                                                                                                            | ✅ Shipped                                                      |
| `fsmlet`, `registerFsmlet`, loop                         | `packages/fsm-sync-worker-ts/src/fsmlet/fsmlet.ts`, `packages/fsm-core-db-ts/src/fsm-workerlet.ts` (`fsm_workerlet` table)                                                                            | ✅ Shipped                                                      |
| heartbeat (5s)                                           | `fsmletHeartbeat` (`HEARTBEAT_INTERVAL_MS = 5_000`); `asyncOperationWorkerletHeartbeat` is the 🗄️ superseded equivalent — `fsm-core-async-op-worker` has no heartbeat yet (see section 3)             | ✅ Shipped (sync) — ⚠️ Not implemented (current async)          |
| scheduler / dispatch (FSM)                               | `fsmscheduler.ts`, `schedule_next_pending`, `enqueue_fsm_dispatch_v2`, `fsm_dispatch_queue`                                                                                                           | ✅ Shipped                                                      |
| fsmlet ↔ async-actor liveness check                      | `asyncOperationVerificationMode` (`checkRegistryForAsyncActors` / `checkRegistryAndWorkingForAsyncActors`) — library option, not exposed as an `fsmlet` CLI flag                                      | ⚠️ Shipped, not wired to CLI                                    |
| `fsmctl` (control CLI)                                   | `packages/fsm-sync-worker-ts/src/cli/fsmctl.ts` — `create` / `resume` / `send` / `stop`                                                                                                               | ✅ Shipped                                                      |

## References

- Compiler CLI —
  [`cli-usage.md`](./packages/fsm-compiler-ts/docs/guides/cli-usage.md)
- Sync worker CLI —
  [`CLI-USAGE.md`](./packages/fsm-sync-worker-ts/docs/guides/CLI-USAGE.md)
- Async-operation worker CLI (current) —
  [`CLI-USAGE.md`](./packages/fsm-core-async-op-worker/docs/guides/CLI-USAGE.md)
- Async-operation worker CLI (old, superseded) —
  [`CLI-USAGE.md`](./packages/fsm-async-worker-ts/docs/guides/CLI-USAGE.md)
- Proto codegen (gateway wire stubs) —
  [`fsm-proto-codegen/README.md`](./packages/fsm-proto-codegen/README.md)
- Worker control plane —
  [`adr-002-fsm-sync-operation-worker-execution-model.md`](./docs/adr/adr-002-fsm-sync-operation-worker-execution-model.md)
- Polyglot direction —
  [`adr-003-fsm-async-operation-polyglot-actor-execution-model.md`](./docs/adr/adr-003-fsm-async-operation-polyglot-actor-execution-model.md)
