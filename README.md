<h1 align="center">FSM Framework — Lifecycle</h1>

<p align="center">
  A framework for running versioned finite state machines inside PostgreSQL.
</p>

<p align="center">
  <a href="./CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs welcome"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0"></a>
</p>

This document is a **design specification** for the end-to-end lifecycle of an
FSM: how you go from a state-machine definition to a running workflow. You
**design** a machine, **scaffold** the code that implements its operation logic,
then run two cooperating worker daemons that execute it — the
**`asyncOperationlet`** (runs async operation logic / actors) and the
**`fsmlet`** (drives the state machine itself).

> **Status — read this first.** This is the _target_ design. Some pieces ship
> today; some are the intended end state. Each step below is tagged **✅
> Shipped** or **🔭 Planned**. The
> [Maps to today's code](#appendix-maps-to-todays-code) appendix ties every
> design term to what exists now. The most significant gap is polyglot support:
> the `fsmLanguage` model is specced (and partly reserved in the schema) but the
> toolchain is TypeScript-only today.

```
┌───────────┐  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────┐  ┌──────────┐
│ 1. design │─▶│ 2+3. scaffold   │─▶│ 4+5. validate    │─▶│ 6. asyncOperation│─▶│ 7. fsmlet│
│  fsm.json │  │ async+sync logic│  │  + load to PG    │  │     let (actors) │  │  (states)│
└───────────┘  └─────────────────┘  └──────────────────┘  └──────────────────┘  └──────────┘
              every step reads and writes through PostgreSQL as the source of truth
```

**Two kinds of operation logic.** A state machine references two families of
user code:

- **Sync operation logic** — `actions`, `guards`, `delays`. Pure/inline; runs
  inside a single macrostep of the `fsmlet`.
- **Async operation logic** — `actors` (the `invoke` objects on a state).
  Long-running; each runs in its own queue and process, driven by the
  `asyncOperationlet`, and reports back with `xstate.done.actor.<id>` /
  `xstate.error.actor.<id>` events.

---

## 1. Design your FSM JSON schema

An FSM is authored as an XState 5 machine and compiled into `fsm.json` (the
normalized form loaded into PostgreSQL) plus `xstate-fsm.json` (the raw XState
representation). Definitions live in versioned folders, e.g.
`apps/fsm-core-example/fsm/creditCheck/v01/`.

Reference: the JSON Schema at
[`packages/database-src/fsm.machine.schema.v3.json`](./packages/database-src/fsm.machine.schema.v3.json)
and the format guide at
[`fsm-definition-format.md`](./packages/fsm-compiler-ts/docs/reference/fsm-definition-format.md).

### 1.a From an existing XState machine — ✅ Shipped

If you already have an XState machine, point the compiler at its `machine.ts`
and it emits `fsm.json` + `xstate-fsm.json`:

```bash
# From a single machine.ts
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate \
  -f apps/fsm-core-example/fsm/creditCheck/v01/machine.ts
```

### 1.b From scratch — ✅ Shipped

Hand-author `fsm.json` directly against
[`fsm.machine.schema.v3.json`](./packages/database-src/fsm.machine.schema.v3.json)
— no XState source needed. Author the states, transitions, and `invoke` objects
by hand, then validate the file against the schema with any JSON Schema
validator, e.g. [`ajv-cli`](https://github.com/ajv-validator/ajv-cli):

```bash
npx ajv-cli validate \
  -s packages/database-src/fsm.machine.schema.v3.json \
  -d apps/fsm-core-example/fsm/creditCheck/v01/fsm.json
```

### The `invoke` object

Each state may declare async operation logic through an `invoke` array. This is
the seam between the machine and its actors:

```jsonc
{
  "invoke": [
    {
      "type": "xstate.invoke",
      "id": "creditBureauCheck",
      "src": "checkBureau", // exported fn in <lang>/actors/<fsmType>_<fsmVersion>_checkBureau.<ext>
      "fsmType": "promise", // promise | sharedPromise | sharedFsm | fsm
      "fsmVersion": "1",
      "fsmLanguage": "typescript" // typescript | python | rust | llm  (🔭 reserved)
    }
  ]
}
```

`fsmType` and `fsmVersion` are required and understood today. `fsmLanguage` is
reserved in the schema (default `typescript`) and selects which language's actor
folder implements the operation logic — the routing key for the polyglot model
in sections 2 and 6.

---

## 2. Scaffold async operation logic (actors / `invoke` objects)

From a compiled `fsm.json`, generate **base (stub) code** for every actor
referenced by an `invoke` object — both **internal actors** (implemented and run
inside this project) and **external actors** (implemented and run by another
service/fleet). Each actor is generated in the language declared by its invoke
object's `fsmLanguage`, so a single machine can spread its async operation logic
across runtimes.

**✅ Shipped** — `generate-async-logic` writes one file per invoke, routed by
`fsmLanguage`:

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate-async-logic \
  -f apps/fsm-core-example/fsm
```

Each invoke object gets its **own file** named
`<fsmType>_<fsmVersion>_<src>.<ext>` (exporting one function named after the
actor `src`), in its `fsmLanguage` folder:

```
creditCheck/v01/
  typescript/actors/promise_v01_checkBureau.ts     # fsmLanguage: "typescript"
  python/actors/promise_v01_scoreReport.py         # fsmLanguage: "python"
  rust/actors/promise_v01_riskModel.rs             # fsmLanguage: "rust"
  go/actors/promise_v01_notify.go                  # fsmLanguage: "go"
```

Supported languages: `typescript`, `python`, `rust`, `go`. Actors with an
unsupported `fsmLanguage` are skipped with a warning.

> **🔭 Planned:** the generated actor stub signature does not yet match the
> worker's `(input) => Promise<output>` calling convention, and external actors
> are still stubbed locally rather than referenced. See the compiler
> [TODO](./packages/fsm-compiler-ts/docs/todo/TODO.md).

---

## 3. Scaffold sync operation logic (actions / guards / delays)

The `generate-sync-logic` command scaffolds the **sync operation logic** — one
stub per `action`, `guard`, and `delay` referenced in `fsm.json` — in the
language(s) passed via `--lang` (`typescript`, `python`, `rust`, `go`;
comma-separated, default `typescript`):

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate-sync-logic \
  -f apps/fsm-core-example/fsm \
  --lang typescript,python
```

```
<lang>/
  actions/<index>   # side effects
  guards/<index>    # transition predicates (return boolean)
  delays/<index>    # delay durations (return ms)
```

Unlike actors, this logic runs **inline inside a macrostep** of the `fsmlet` —
no separate queue or process. **✅ Shipped** for all four languages.

> **🔭 Planned:** action stubs are emitted as `(context, event)` and guard stubs
> as `(context, event)`, but the worker invokes them as
> `(context, params, meta)` / `(context, cond, meta)`. See the compiler
> [TODO](./packages/fsm-compiler-ts/docs/todo/TODO.md).

Fill in the stubs, then validate exports without touching the database:

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-sync-operation \
  -f apps/fsm-core-example/fsm \
  -w fsm
```

---

## 4. Validate and load async operation logic

Once the actor stubs from section 2 are filled in, validate that each async
operation-logic module actually exports its named function, then load its
metadata into PostgreSQL — the DB-side half of the seam the `asyncOperationlet`
(section 6) consumes when it spawns actor processes.

```bash
# Validate all languages (calls each language's runtime)
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-async-operation \
  -f apps/fsm-core-example/sharedFSM \
  -w sharedPromise

# Validate a specific language only
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-async-operation \
  -f apps/fsm-core-example/sharedFSM \
  -w sharedPromise \
  --lang typescript

# Validate then load into PostgreSQL
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-async-operation-and-load \
  -f apps/fsm-core-example/sharedFSM \
  -w sharedPromise \
  --db-url postgresql://user:pass@localhost:5432/db
```

`--db-url` overrides `DATABASE_URL`; when omitted, the connection string is read
from `DATABASE_URL` in `.env`.

**✅ Shipped** — per-actor function validation across all four languages. Each
language's runtime is invoked to confirm the function is defined — not just that
the file exists:

| Language     | Runtime called                                         |
| ------------ | ------------------------------------------------------ |
| `typescript` | `deno run src/checkers/check_fn.ts <file> <fn>`        |
| `python`     | `python3 src/checkers/check_fn.py <file> <fn>`         |
| `go`         | `go build -o binary src/checkers/check_fn.go` → binary |
| `rust`       | `rustc src/checkers/check_fn.rs` → binary, then binary |

Use `--lang` (comma-separated) to restrict validation to a specific language
subset. When `--lang` is omitted, all actor languages are checked.

> **🔭 Planned:** loading the async operation-logic metadata (actor name,
> version, language, queue) into PostgreSQL. Today `validate-async-operation`
> validates and returns results without persisting them;
> `validate-async-operation-and-load` validates `sharedPromise` modules but the
> DB write is not yet wired. See the compiler
> [TODO](./packages/fsm-compiler-ts/docs/todo/TODO.md).

---

## 5. Validate and load sync operation logic

Once the action / guard / delay stubs from section 3 are filled in, validate
that every one is exported with the right shape, then load `fsm.json` into
PostgreSQL so the `fsmlet` (section 7) can drive the machine.

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-sync-operation-and-load \
  -f apps/fsm-core-example/fsm \
  -w fsm \
  --db-url postgresql://user:pass@localhost:5432/db
```

`--db-url` overrides `DATABASE_URL`; when omitted, the connection string is read
from `DATABASE_URL` in `.env`.

**✅ Shipped** — validates every action, guard, and delay via
`validateSyncOperationFromFolder`, and on success loads the machine into
PostgreSQL via `loadFsmFromJson` → `load_fsm_from_json_v2`.

---

## 6. Start the `asyncOperationlet` (async-operation worker)

The `asyncOperationlet` is the daemon that runs **async operation logic** — the
conceptual twin of the `fsmlet`. It takes a **folder path** and a **`lang`**
list (comma-separated languages to activate).

**🔭 Planned — intended CLI:**

```bash
asyncOperationlet --folder-path apps/fsm-core-example/fsm --lang typescript,python
```

### 6.a For each folder — 🔭 Planned (validation/load ✅ Shipped for TS)

1. **Validate `fsm.json`** against the machine schema.
2. **Validate every async operation-logic function** referenced by an `invoke`
   object, _per its `fsmLanguage`_ — confirm each `<lang>/actors/` file exports
   the named function with the right shape.
3. **Load the async operation-logic metadata** (actor name, version, language,
   queue) into PostgreSQL.

> Today, per-`invoke` validation exists for all four languages via
> `validate-async-operation` (each language's runtime is called — see §4);
> metadata load into PostgreSQL and liveness registry are the planned
> extensions.

### 6.b Spawn a process per successful actor — 🔭 Planned

For each actor that validated and loaded, the `asyncOperationlet` spawns a new
process that runs **`processPromiseQueueMessage`** — a loop that reads its
actor's queue, invokes the operation-logic function with the message payload,
and archives the result back to the parent FSM instance's queue.

The shipped basis for this is the promise worker (**✅ Shipped**), startable
directly today:

```bash
# Shipped promise worker — one actor queue, TypeScript
deno task cli \
  -c create-and-start-promise-worker \
  -q checkBureau_v01 \
  -t checkBureau \
  -n creditCheck \
  -v 1 \
  -f /abs/path/to/apps/fsm-core-example/fsm/creditCheck/v01
```

### 6.c Register the spawned process — 🔭 Planned

Each spawned async-operation process is registered in an
**`async_operation_instance_status`** table so the control plane knows which
operation logic is live and in which runtime:

| Column        | Meaning                                        |
| ------------- | ---------------------------------------------- |
| `parent_pid`  | PID of the `asyncOperationlet` that spawned it |
| `parent_lang` | Language of the parent                         |
| `child_pid`   | PID of the spawned (child) actor process       |
| `child_lang`  | Language of the child process                  |

This registry is what the `fsmlet` consults in step 7.a.iii before it will run a
machine that invokes those actors.

> Today there is no such table: actor subprocesses are spawned inside the
> `fsmlet` and their live queues are tracked on
> `fsm_instance.total_promise_queue_data`. The registry is the planned home for
> cross-language actor liveness.

---

## 7. Start the `fsmlet` (FSM worker)

The `fsmlet` is the node agent (kubelet equivalent) that **drives state
machines**: it runs sync operation logic, fires transitions, and coordinates the
async actors registered in step 6. It takes a **folder path** and a **max
`fsmworker`** count.

**✅ Shipped CLI:**

```bash
deno run --allow-all apps/fsm-core-worker-ts/src/cli/fsmlet.ts \
  -f /abs/path/to/apps/fsm-core-example/fsm \
  -m 8                     # max FSM instances driven concurrently (default 8)
  # -i <fsmlet-id>         # stable identity (default: random UUID per startup)
  # -d <db-url>            # overrides DATABASE_URL
```

### 7.a For each folder

1. **Validate `fsm.json`** against the machine schema. **✅ Shipped**
2. **Validate every sync operation-logic function** (actions, guards, delays).
   **✅ Shipped**
3. **Verify all internal + external actors are present** in
   `async_operation_instance_status` — i.e. every `invoke` target already has a
   live async-operation process. **🔭 Planned**
4. **Load `fsm.json` into PostgreSQL** via `loadFsmFromJson` →
   `load_fsm_from_json_v2`. **✅ Shipped**

### 7.b Register the fsmlet — ✅ Shipped

`registerFsmlet` upserts this node into `fsm_daemon_node` with its loaded FSM
modules and `max_concurrency`, so the scheduler can route work to it.

### 7.c The fsmlet loop — ✅ Shipped

The node `LISTEN`s on `fsm_fsmlet_work_<id>`, claims scheduled work from
`fsm_dispatch_queue`, runs a worker per claimed instance (each worker executes
macrosteps: resolve state → run sync logic → dispatch invokes), and drains
gracefully on `SIGINT`/`SIGTERM`.

### 7.d Heartbeat — ✅ Shipped

`fsmletHeartbeat` updates `last_heartbeat` and `active_workers` on
`fsm_daemon_node` every **5 seconds** (`HEARTBEAT_INTERVAL_MS = 5_000`), with a
30-second fallback poll to catch missed notifications. The scheduler treats a
node with a stale heartbeat (> 30s) as dead and stops routing work to it.

---

## Appendix: Maps to today's code

| Design term (this spec)            | Today's implementation                                                                                                        | Status                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `asyncOperationlet`                | Promise worker — `fsmpromise` routes; `start-promise-worker` CLI                                                              | 🔭 name / ✅ mechanism |
| `processPromiseQueueMessage`       | `processFSMPromiseQueueMessage` (`apps/fsm-core-worker-ts/src/fsmpromiseworker-helper.ts`)                                    | ✅ Shipped             |
| `async_operation_instance_status`  | `fsm_daemon_node` + `fsm_instance.total_promise_queue_data` (no dedicated registry table)                                     | 🔭 Planned             |
| `lang` arg / `fsmLanguage` routing | `generate-sync-logic --lang`; `generate-async-logic` (by `fsmLanguage`); `validate-async-operation --lang`; ts/python/rust/go | ✅ Shipped             |
| async op scaffolding (`actors/`)   | `generate-async-logic` command (`generate-async-operation-logic.ts`)                                                          | ✅ Shipped             |
| sync op scaffolding (actions/…)    | `generate-sync-logic --lang` command (`generate-sync-operation-logic.ts`)                                                     | ✅ Shipped             |
| validate + load `fsm.json`         | `validate-fsm-plugin-load.ts`; `loadFsmFromJson` → `load_fsm_from_json_v2`                                                    | ✅ Shipped             |
| `fsmlet`, `registerFsmlet`, loop   | `apps/fsm-core-worker-ts/src/fsmlet.ts`, `scheduler/fsmlet-registry.ts`                                                       | ✅ Shipped             |
| heartbeat (5s)                     | `fsmletHeartbeat` (`HEARTBEAT_INTERVAL_MS = 5_000`)                                                                           | ✅ Shipped             |
| scheduler / dispatch               | `schedule_next_pending`, `enqueue_fsm_dispatch_v2`, `fsm_dispatch_queue`                                                      | ✅ Shipped             |

## References

- Compiler CLI —
  [`cli-usage.md`](./packages/fsm-compiler-ts/docs/guides/cli-usage.md)
- Worker CLI —
  [`CLI-USAGE.md`](./apps/fsm-core-worker-ts/docs/guides/CLI-USAGE.md)
- Execution model — [`execution-model.md`](./docs/execution-model.md)
- Worker control plane —
  [`adr-002-worker-execution-model.md`](./docs/adr/adr-002-worker-execution-model.md)
- Polyglot direction —
  [`kb-001-distributed-multilang-fsm.md`](./docs/kb/kb-001-distributed-multilang-fsm.md)
