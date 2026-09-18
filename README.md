<h1 align="center">FSM Framework — Lifecycle</h1>

<p align="center">
  A framework for running versioned finite state machines inside PostgreSQL.
</p>

<p align="center">
  <a href="./CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs welcome"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0"></a>
</p>

> This is the **quick-start guide for using the published `@pgfsm/*` packages**
> via `npx` — for building your own FSM app against this framework, no clone of
> this repo required. If you're developing or debugging `fsm-compiler-ts`,
> `fsm-sync-worker-ts`, or `fsm-core-async-op-worker` themselves inside this
> repo, see [DEVELOPER.md](./DEVELOPER.md) instead — same lifecycle,
> `deno run`-first, plus the contributor-facing appendices (superseded worker,
> source↔spec mapping).

This document is the lifecycle spec for an FSM — **design/generate** →
**scaffold** → **validate** → **run the cluster**.

```mermaid
flowchart LR
    A["<b>1. design / generate</b><br/>fsm.json"] --> B["<b>2. scaffold</b><br/>operation logic"]
    B --> C["<b>3. run Workers</b><br>3.a Sync Operation Worker <br>[ @pgfsm/sync-worker ]<br>( ctl  + scheduler + fsmlet ) <br>3.b Async Operation Worker <br>[ @pgfsm/async-worker ]<br> ( ctl  + gateway + Different lang ipc workers )"]
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
| Command | `npx @pgfsm/compiler -c generate-fsm-json -f apps/fsm-core-example/fsm/creditCheck/v01/machine.ts --output apps/fsm-core-example/fsm/creditCheck/v01`                                                                                                                                                                                                                                                                       | `npx ajv-cli validate -s packages/database-src/fsm.machine.schema.v3.json -d apps/fsm-core-example/fsm/creditCheck/v01/fsm.json`                                                      |
| Steps   | 1. Export raw XState JSON → write `xstate-fsm.json`<br>2. Strip null entries from action arrays<br>3. Normalize string actions to `{ type }` objects<br>4. Set `actionName` from `delay` on raise/cancel actions<br>5. Fill in missing `fsmType`/`fsmVersion` on `invoke` (actor) entries<br>6. Write `fsm.json`<br>7. _(optional, `--show-recommendation`)_ validate `fsm.json` against the schema and log recommendations | None — you author `fsm.json` by hand, then run the `ajv-cli` command yourself                                                                                                         |
| Output  | `fsm.json` + `xstate-fsm.json`                                                                                                                                                                                                                                                                                                                                                                                              | `fsm.json`                                                                                                                                                                            |

`@pgfsm/compiler` ships a single CLI bin, so `npx @pgfsm/compiler ...` resolves
it directly — no `-p`/`--package` needed. See
[the package's own README](./packages/fsm-compiler-ts/README.md) for the full
flag reference, or install it once (`npm install -g @pgfsm/compiler`) for a
plain `fsm-compiler` command.

---

## 2. Scaffold FSM operation

From a compiled `fsm.json`, generate **base (stub) code** for the two families
of operation logic a machine can reference:

1. **Async operation logic** — `actors`, via `invoke` objects
2. **Sync operation logic** — `actions`, `guards`, `delays`

Both are driven by the same compiler CLI; they differ in command, language
routing, and where the resulting code runs.

| Info                | Async Operation                                                                                                                                                         | Sync Operation                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| FSM component       | `actors` (the `invoke` objects on a state)                                                                                                                              | `actions`, `guards`, `delays`                                                                                                                   |
| Execution model     | Long-running; each runs in its own queue and process, driven by the async-op worker fleet; reports back via `xstate.done.actor.<id>` / `xstate.error.actor.<id>` events | Pure/inline; runs inside a single macrostep of the sync worker (`fsmlet`) — no separate process                                                 |
| CLI command         | `generate-async-logic`                                                                                                                                                  | `generate-sync-logic`                                                                                                                           |
| Command             | `npx @pgfsm/compiler -c generate-async-logic -f apps/fsm-core-example/fsm`                                                                                              | `npx @pgfsm/compiler -c generate-sync-logic -f apps/fsm-core-example/fsm`                                                                       |
| Language selection  | Per-invoke, from that invoke object's `fsmLanguage` field — a single machine can spread its actors across runtimes                                                      | Via `--lang` flag, applied uniformly to the whole generation run; default (and currently only accepted value) `typescript`                      |
| Languages generated | It will generate code for all 4 languages, one invoke at a time, according to each invoke's `fsmLanguage`                                                               | It will generate TS stubs only — `--lang` with any value other than `typescript` is rejected                                                    |
| Supported languages | `typescript`, `python`, `rust`, `go` — unsupported `fsmLanguage` values are skipped with a warning                                                                      | `typescript` only (`python`/`rust`/`go` are members of `OperationLang` but not yet maintained/tested for this command, so the CLI rejects them) |
| File naming         | One file per invoke, in its own subfolder: `<src>/<src>.<ext>` (exports one function named after the actor `src`)                                                       | One stub per `action` / `guard` / `delay` referenced in `fsm.json`                                                                              |
| Output layout       | `<fsmLanguage>/actors/<src>/<src>.<ext>`                                                                                                                                | `<lang>/actions/<index>`, `<lang>/guards/<index>`, `<lang>/delays/<index>`                                                                      |

Both `generate-sync-logic` and `generate-async-logic`'s `-f`/`--folder` also
accept a single `fsm.json` file (instead of only a plugin-root directory), in
which case `-o`/`--output` is required — a relative or absolute path naming the
version folder to scaffold stubs into, resolved independently of where the
`fsm.json` itself lives. `generate-async-logic` additionally refreshes the
aggregate registry/worker SDK in both `-f`/`--folder` shapes, not just directory
mode — there's no separate flag for where that lands: one level above
`-f`/`--folder` (the app root) in directory mode, or into `-o`/`--output` in
single-`fsm.json` mode. See
[the package's own README](./packages/fsm-compiler-ts/README.md) for details and
examples.

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
npx @pgfsm/compiler -c validate-sync-operation -f apps/fsm-core-example/fsm -w fsm
```

---

## 3. Start the workers

The FSM side runs as a **node agent** (kubelet equivalent) — it validates, loads
its modules, and registers itself, then waits for its companion **scheduler**
(kube-scheduler equivalent, a separate control-plane process — see
[section 4](#4-start-the-schedulers)) to route claimed work to it via
`pg_notify`.

The async-operation side does **not** follow that kube-style node-agent /
scheduler split. It runs as a single long-running **Activity Gateway**
(`@pgfsm/async-worker`, bin `async-operation-worker-gateway`) that starts a
sidecar Unix socket for the per-language **lang ipc workers** to register their
actors against, then polls Postgres directly on its own interval to claim and
dispatch work — no separate scheduler process, no `pg_notify`.

| Info                 | Async-Operation Worker — `@pgfsm/async-worker`                                                                                                                             | Sync-Operation Worker — `@pgfsm/sync-worker`                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drives               | Async operation logic (`actors`) — dispatches to already-running per-language worker-sdk processes over the sidecar socket, one fire-and-forget dispatch per claimed event | State machines — sync operation logic, transitions, and dispatching invokes                                                                         |
| Runtime language     | Polyglot (multi-language) — driven by `fsmLanguage` (`typescript`/`python`/`go`/`rust`), always dispatched over the sidecar socket, never in-process                       | TypeScript only                                                                                                                                     |
| Bins in this package | `async-operation-worker-gateway` (the process), `async-operation-worker-gateway-ctl` (one-shot debug client)                                                               | `fsmlet` (node agent), `fsmscheduler` (control-plane router), `fsmctl` (one-shot control CLI), `pgcron` (deploy-time alternative to `fsmscheduler`) |
| Registers itself in  | In-memory only, no DB table (per-worker registration over `--sidecar-socket`); optional `--ensure-queue-on-register` also ensures a PGMQ queue per registered actor        | `fsm_daemon_node` table                                                                                                                             |
| Listens on           | `--sidecar-socket` (Unix socket) — no `pg_notify` channel; the poll loop pulls from Postgres itself every `--poll-interval-ms` (default 30s)                               | `daemon_{id}_start`/`daemon_{id}_resume`, routed by `fsmscheduler`                                                                                  |
| Concurrency model    | Fire-and-forget per claimed event — each event dispatches over the socket to the already-running worker-sdk process for that actor, which owns its own concurrency         | One FSM worker per claimed instance, bounded by `--max-concurrency` semaphore (default `8`)                                                         |
| Heartbeat            | Not implemented yet                                                                                                                                                        | Every 5s, so `fsmscheduler` can score this node                                                                                                     |
| Graceful shutdown    | `SIGINT`/`SIGTERM` stops the poll loop, closes the sidecar/Unix socket; a second signal force-exits                                                                        | `SIGINT`/`SIGTERM` drains active workers, deregisters; a second signal force-exits                                                                  |

### Start the async-operation worker

```bash
# Sidecar (worker registration) + gRPC/Connect gateway + 30s poll loop —
# standalone: no companion scheduler process, no pg_notify
npx -p @pgfsm/async-worker -- async-operation-worker-gateway \
  --bind unix:/tmp/pgfsm-activity-gateway.sock \
  --sidecar-socket /tmp/pgfsm-activity-gateway-workers.sock \
  --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  --poll-interval-ms 30000
  # --disable-poll-loop        # gateway/sidecar only, no DB connection needed
  # --ensure-queue-on-register # auto-create a PGMQ queue for every newly registered actor
```

`@pgfsm/async-worker` ships two bins, so a plain `npx @pgfsm/async-worker` can't
tell which one to run — pass `-p @pgfsm/async-worker` and name the bin after
`--`, as above (or install it once — `npm install -g @pgfsm/async-worker` — for
plain `async-operation-worker-gateway`/`-ctl` commands). Needs at least one
per-language worker-sdk process to connect to `--sidecar-socket` and register
its actors — see
[the package's own README](./packages/fsm-core-async-op-worker/README.md) for
the full flag reference, startup sequence, and PGMQ message payload shape.

### Start the worker SDK itself

One process per language that has actors, generated by `@pgfsm/compiler`'s
`generate-async-logic` command into
`apps/fsm-core-example/worker-sdk-generated/<lang>/` (run that command first if
the directory doesn't exist yet — `-f apps/fsm-core-example/fsm` is enough; the
command writes the aggregate one level above `--folder`, i.e. the **app root**,
automatically; see [section 2](#2-scaffold-fsm-operation)). Each connects to the
gateway's `--sidecar-socket` above and serves invocations for every actor
compiled into its registry until stopped.

This generated code is your own project's, so it runs with each language's own
toolchain — not `npx`. Each of these is a **long-running foreground process**
(it serves invocations until stopped) — run one at a time, each in its own fresh
terminal at your project root.

```bash
# TypeScript — the compiler generates Deno source, so this still needs a Deno
# install (`deno run`, not `npx`/`node`) even in the npx-first flow
deno run --allow-all apps/fsm-core-example/worker-sdk-generated/typescript/cli.ts start \
  --gateway-socket /tmp/pgfsm-activity-gateway-workers.sock
```

```bash
# Python
cd apps/fsm-core-example/worker-sdk-generated/python
python3 -m pip install -r requirements.txt
python3 cli.py start --gateway-socket /tmp/pgfsm-activity-gateway-workers.sock
```

```bash
# Go — must run from inside its own directory (go.mod resolves relative to it)
cd apps/fsm-core-example/worker-sdk-generated/go
go run . --gateway-socket /tmp/pgfsm-activity-gateway-workers.sock
```

```bash
# Rust — same directory requirement as Go
cd apps/fsm-core-example/worker-sdk-generated/rust
cargo run --release -- --gateway-socket /tmp/pgfsm-activity-gateway-workers.sock
```

`list` (TypeScript/Python only) prints the actors compiled into that process's
registry without connecting to the gateway — useful to sanity-check a generated
registry before wiring up the real socket.

### Start the FSM worker

```bash
# Node agent — validates, loads fsm.json, registers, then waits for work
npx -p @pgfsm/sync-worker -- fsmlet \
  -f /abs/path/to/apps/fsm-core-example/fsm \
  -m 8                     # max FSM instances driven concurrently (default 8)
  # -i <fsmlet-id>         # stable identity (default: random UUID per startup)
  # -d <db-url>            # overrides DATABASE_URL
```

`@pgfsm/sync-worker` ships four bins (`fsmlet`, `fsmscheduler`, `fsmctl`,
`pgcron`), so a plain `npx @pgfsm/sync-worker` can't tell which one to run —
pass `-p @pgfsm/sync-worker` and name the bin after `--`, as above (or install
it once — `npm install -g @pgfsm/sync-worker` — for plain `fsmlet`/
`fsmscheduler`/`fsmctl`/`pgcron` commands). This node agent needs its companion
**FSM scheduler** running somewhere in the cluster to ever receive claimed work
— see [section 4](#4-start-the-schedulers). See
[the package's own README](./packages/fsm-sync-worker-ts/README.md) for the full
flag reference and startup sequence.

---

## 4. Start the schedulers

The FSM Sync-Operation Worker has a companion **scheduler** — a control-plane
routing process (kube-scheduler equivalent) run once per cluster, never on a
worker node. It listens for a `pg_notify` wake-up, then loops a single PG
function that atomically claims the next pending dispatch entry, filters/scores
active `fsmlet`s, assigns the winner, and notifies it — repeating until the
queue is empty or no `fsmlet` has capacity. A fallback poll catches any
notification missed after a `LISTEN` connection drop.

`@pgfsm/async-worker` (the async-operation worker) has **no scheduler** — it
polls Postgres directly on its own interval instead (see
[section 3](#3-start-the-workers)).

| Info                | FSM Scheduler                                                                |
| ------------------- | ---------------------------------------------------------------------------- |
| Bin                 | `fsmscheduler` (`@pgfsm/sync-worker`)                                        |
| Routes work for     | `fsmlet` node agents                                                         |
| Listens on          | `fsm_scheduler_work`                                                         |
| Dispatch table      | `fsm_dispatch_queue`                                                         |
| `--stale-threshold` | Seconds before a fsmlet with no heartbeat is treated as dead (default `30`)  |
| `--poll-interval`   | Fallback poll interval in ms, catches missed notifications (default `30000`) |
| Deployment          | Control plane, alongside your API server — **not** on worker nodes           |

### Start the FSM scheduler

```bash
npx -p @pgfsm/sync-worker -- fsmscheduler
  # -d <db-url>             # overrides DATABASE_URL
  # -p <poll-interval-ms>   # fallback poll interval (default 30000)
  # -s <stale-threshold-s>  # seconds before a fsmlet is considered dead (default 30)
```

### Alternative: `pg_cron` instead of a standing scheduler process

If you'd rather not run `fsmscheduler` as a standing process at all, `pgcron` is
a one-shot CLI that registers a `pg_cron` job to do the same scheduling work on
a periodic in-database timer instead of a `LISTEN`/poll loop.

```bash
npx -p @pgfsm/sync-worker -- pgcron
  # -d <db-url>    # overrides DATABASE_URL
  # -s <schedule>  # pg_cron schedule expression (default "5 seconds")
```

Run it once to register (or update) the job — it doesn't run as a standing
process itself, it just calls PostgreSQL's `cron.schedule()` and exits. With
`pg_cron` handling scheduling, the standing `fsmscheduler` process is optional.

---

## 5. Control the cluster (`ctl`)

Each dispatch model has a one-shot **control CLI** (kubectl equivalent) — unlike
the node agents and schedulers in sections 3–4, these issue a single command
against PostgreSQL (or, for the async-operation gateway, the gateway's gRPC API)
and exit; they don't validate, register, or listen for work.

| Info           | `fsmctl` (`@pgfsm/sync-worker`)                                                                                    | `async-operation-worker-gateway-ctl` (`@pgfsm/async-worker`)                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Controls       | FSM instances — the dispatch-queue model driven by the `fsmscheduler`/`fsmlet` pair                                | A running `@pgfsm/async-worker` gateway, over its gRPC/Connect API                                                                                                                         |
| Commands       | `create`, `resume`, `send`, `stop`                                                                                 | `list`, `invoke`                                                                                                                                                                           |
| `create`       | Creates a new FSM instance, its pgmq queue, sends `initialTransition_event`, and enqueues to `fsm_dispatch_queue`  | — (no equivalent — instances/dispatch aren't this ctl's concern)                                                                                                                           |
| `resume`       | Re-enqueues an existing FSM instance to the `fsmscheduler`                                                         | — (no equivalent)                                                                                                                                                                          |
| `send`         | Sends an event to a running FSM instance                                                                           | — (no equivalent)                                                                                                                                                                          |
| `stop`         | Sends a stop signal to a running `fsmlet` worker via `pg_notify`                                                   | — (no equivalent)                                                                                                                                                                          |
| `list`         | — (no equivalent)                                                                                                  | Prints the actor keys currently registered with the gateway                                                                                                                                |
| `invoke`       | — (no equivalent)                                                                                                  | Calls an actor directly against the gateway and prints the result — debug/test only                                                                                                        |
| Required flags | `-c/--command`, plus per-command: `create` needs `-n/-v`; `resume`/`send`/`stop` need `-q`; `send` also needs `-e` | none for `list`; `invoke` needs `--parent-fsm-name`, `--parent-fsm-version`, `--async-operation-type`, `--async-operation-name`, `--async-operation-version`, `--async-operation-language` |
| Depends on     | `fsmscheduler` + `fsmlet` running to pick up the dispatched/resumed/sent work                                      | A running `async-operation-worker-gateway` process — talks only to the gateway, never touches Postgres or the sidecar socket directly                                                      |

```bash
# fsmctl
npx -p @pgfsm/sync-worker -- fsmctl -c create -n creditCheck -v 1
npx -p @pgfsm/sync-worker -- fsmctl -c resume -q <instance-uuid>
npx -p @pgfsm/sync-worker -- fsmctl -c send -q <instance-uuid> -e APPROVE
npx -p @pgfsm/sync-worker -- fsmctl -c stop -q <instance-uuid>

# async-operation-worker-gateway-ctl
npx -p @pgfsm/async-worker -- async-operation-worker-gateway-ctl list
npx -p @pgfsm/async-worker -- async-operation-worker-gateway-ctl invoke \
  --parent-fsm-name creditCheck --parent-fsm-version v01 \
  --async-operation-type internalAsyncOperation --async-operation-name checkBureau --async-operation-version v01 \
  --async-operation-language typescript \
  --input '{"ssn":"123"}'
```

See [the sync-worker package's README](./packages/fsm-sync-worker-ts/README.md)
(`fsmctl`) and
[the async-worker package's README](./packages/fsm-core-async-op-worker/README.md)
(`async-operation-worker-gateway-ctl`) for the full flag reference.

---

## References

- Compiler CLI (`@pgfsm/compiler`) —
  [`packages/fsm-compiler-ts/README.md`](./packages/fsm-compiler-ts/README.md)
- Sync worker CLI (`@pgfsm/sync-worker`) —
  [`packages/fsm-sync-worker-ts/README.md`](./packages/fsm-sync-worker-ts/README.md)
- Async-operation worker CLI (`@pgfsm/async-worker`) —
  [`packages/fsm-core-async-op-worker/README.md`](./packages/fsm-core-async-op-worker/README.md)
- Worker control plane —
  [`adr-002-fsm-sync-operation-worker-execution-model.md`](./docs/adr/adr-002-fsm-sync-operation-worker-execution-model.md)
- Polyglot direction —
  [`adr-003-fsm-async-operation-polyglot-actor-execution-model.md`](./docs/adr/adr-003-fsm-async-operation-polyglot-actor-execution-model.md)
- Developing or debugging this framework itself, in this repo —
  [`DEVELOPER.md`](./DEVELOPER.md)
