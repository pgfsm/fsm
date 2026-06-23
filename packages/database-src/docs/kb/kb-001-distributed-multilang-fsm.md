# KB-001: Distributed, Multi-Language FSM Execution — Architecture & Best Practices

**Status:** Knowledge Base / Design Guidance
**Date:** 2026-06-13
**Relates to:** ADR-003 (worker process model), ADR-004 (master dispatch queue)

---

## 1. Problem statement

We want a distributed FSM platform where:

1. A single `fsm.json` can have **actors/actions/guards implemented in different languages** (TS, Python, Rust, Go…).
2. **Many instances of the same FSM** run concurrently; each instance has its own durable queue and is driven forward independently.
3. A worker **starts when an instance is created**, **out-of-band from the API** (the HTTP tier never blocks on or owns worker lifecycle).
4. **Database connections (pg Pool objects) are minimized**, even as instance count and the number of polyglot actor processes grow.

This KB captures the recommended architecture and the trade-offs behind it.

---

## 2. The core distinction: Orchestrator vs Activity

The single most important idea — borrowed from **Temporal** (workflow vs activity) and **AWS Step Functions** (state machine vs activity worker):

| Concern | What it does | Needs DB? | Language |
| --- | --- | --- | --- |
| **Orchestrator** (FSM driver) | Read instance queue → resolve state → evaluate transitions/guards → run *pure* actions → persist macrostep | **Yes** (the only DB-touching tier) | Fixed (TS today) |
| **Activity worker** (actor) | Execute one unit of business logic for an `invoke`d actor: take input, do work, return output | **No** (ideally) | **Any** |

The current code conflates them: the orchestrator `import()`s `typescript/actors/index.ts` and runs actor code **in-process** (`fsmworker.ts:141`). That hard-binds actors to Deno/TS and forces every actor to share the orchestrator's runtime and DB pool.

**Decoupling the two along a queue boundary is what makes the system both polyglot and connection-frugal.**

> The repo is already 80% of the way here: actors run as **promise workers on their own pgmq queues** (`bootstrap-fsm-modules.ts:131`, `fsmpromiseworker.ts`). That queue is the seam — we just stop assuming the consumer on the other side is TS.

---

## 3. Recommended architecture

```
                 POST /fsm/instances                 (API: thin, no worker lifecycle)
                        │
                        ▼
        create_fsm_instance_from_name_v2()            (PG function)
          • INSERT fsm_instance (worker_locked=false)
          • pgmq.send("master_worker_dispatch_queue", instance_row)
                        │
                        ▼
        ┌───────────────────────────────────────────┐
        │   Orchestrator FLEET  (N standing procs)   │  ← NOT one process per instance
        │   • lease instance via lock_fsm_instance   │
        │   • multiplex many instances per process   │
        │   • small pg Pool each, behind PgBouncer   │
        └───────────────────────────────────────────┘
                        │  on invoke(actor)
                        ▼
        pgmq / broker:  activity task  { actor, version, input, instance_id, corr_id }
                        │
        ┌───────────────┼───────────────┬───────────────┐
        ▼               ▼               ▼               ▼
   TS activity     Python activity   Rust activity   Go activity     ← polyglot fleet
   worker          worker            worker          worker             (NO direct DB)
        │               │               │               │
        └───────────────┴───────────────┴───────────────┘
                        │  result event
                        ▼
        back onto the instance queue → orchestrator resumes
```

### 3.1 Replace "one process per instance" with a bounded orchestrator fleet

**Problem with today's dispatcher:** `run-fsm-dispatch-daemon.ts:45` does `new Deno.Command(...).spawn()` per dispatch message, and each child runs `bootstrapFsmModules()` → `new Pool()` (`bootstrap-fsm-modules.ts:51`). So:

```
connections ≈ (active instances) × (pool size per worker)
processes   ≈ active instances
```

1 000 live FSMs ⇒ ~1 000 processes and potentially thousands of PG connections. That is the connection explosion you want to avoid.

**Fix:** a **fixed-size fleet** (e.g. 4–16 long-running orchestrator processes) that each **lease and multiplex many instances**. This is the Temporal worker model: a bounded fleet polling shared queues, each running thousands of executions cooperatively (async, not 1 thread/process per execution).

```
connections ≈ (fleet size) × (small pool size)        ← independent of instance count
processes   ≈ fleet size                               ← bounded
```

Concurrency safety is **already in place**: `lock_fsm_instance` does an atomic `UPDATE … WHERE worker_locked = false` on `fsm_instance` (see ADR-003/004 + `fsm-instance-lock.ts`). A fleet member leases an instance, drives it until it blocks/sleeps/terminates, releases the lock, moves on. The pgmq visibility timeout makes lease loss self-healing.

> Keep the dispatch queue (ADR-004) — it gives near-zero dispatch latency (push, not scan). Just change the consumer from "spawn a process" to "an idle fleet slot picks it up." Keep the watchdog scan as the recovery net (ADR-004 §Watchdog).

**This directly satisfies requirement #3:** the API only does `create + enqueue`; a pre-warmed fleet reacts. Worker startup is fully out-of-band, and there is no per-request process spawn.

### 3.2 Make actors polyglot via the queue, not via `import()`

The orchestrator must **never** call actor code directly. On `xstate.invoke` it enqueues an **activity task** and returns; the actor result arrives later as an event on the instance queue (this is exactly what the promise-worker path already models).

Folder convention extends cleanly:

```
creditCheck/v01/
  fsm.json
  typescript/actors/index.ts      # TS-implemented actors
  python/actors/...               # Python-implemented actors
  rust/actors/...                 # Rust-implemented actors
```

The compiler (`fsm-compiler-ts` / `fsm-compiler-py`) registers, per actor, **which language/queue implements it**. Each language has its own activity-worker fleet subscribed to the actor queues it owns. Adding a language = deploying a new fleet; the orchestrator is unchanged.

**Contract (language-neutral):** an activity worker receives `{ actor, version, input, instance_id, correlation_id }` and returns `{ output | error }`. No FSM internals, no SQL. Idempotency via `correlation_id` (at-least-once delivery).

### 3.3 Transport choice for the polyglot boundary (the DB-connection lever)

This is where "minimize DB connections" is won or lost. Three options:

| Option | Polyglot worker connects to | DB conns from actor fleet | Notes |
| --- | --- | --- | --- |
| **A. Direct pgmq** | Postgres (pg client per lang) | **High** — every actor worker holds PG conns | Simplest, but every Python/Rust/Go worker = more PG connections. **Defeats the goal.** |
| **B. Activity Gateway** (recommended) | A thin gRPC/HTTP service that owns the pool | **Low** — only the gateway pool | One service brokers task fetch + result submit. Polyglot workers hold **zero** PG connections. |
| **C. Neutral broker** (NATS / Redis Streams / RabbitMQ) | The broker | **Low** — a bridge moves pgmq↔broker | pgmq stays the durable source of truth; a single bridge process syncs to a broker that polyglot workers consume. |

**Recommendation:** keep **pgmq as the durable backbone**, and put either an **Activity Gateway (B)** or a **broker bridge (C)** between Postgres and the polyglot actor fleet. Then:

- The **only** tier holding PG connections is the orchestrator fleet (+ gateway/bridge).
- The polyglot actor fleet scales to dozens of languages/processes **without adding a single PG connection**.

### 3.4 Put a connection pooler in front of Postgres — non-negotiable at scale

Regardless of the above, run **PgBouncer** (or **Supabase Supavisor**) in **transaction pooling** mode. Logical pools in every worker then multiplex onto a tiny set of physical backend connections.

- Keep each worker `Pool` **small** (e.g. `max: 2–5`). The FSM model is queue-bound, not connection-bound — workers spend most time waiting on pgmq, not holding a connection.
- Net physical connections = `pooler backend size` (a fixed, tuned number), **not** `Σ worker pools`.
- Caveat: transaction-mode pooling disallows session-level features (some prepared statements, `LISTEN/NOTIFY`, advisory **session** locks). Note: the codebase uses `pgListenerForWorkerStopEvent` (`LISTEN` on `fsm_worker_stop`) — **`LISTEN` needs a session connection**, so give the LISTEN consumer a *direct* connection (bypass the transaction pooler) and route everything else through the pooler.

---

## 4. Distributed-systems best practices that apply here

- **At-least-once, design for idempotency.** pgmq + visibility timeout = at-least-once. Every actor and every macrostep must tolerate redelivery (use `correlation_id` / msg dedup; the macrostep already keys off DB state, which helps).
- **The queue is the contract.** Decouple tiers by message schema, not by shared code/imports. Version the message payload.
- **Lease, don't assign.** Workers pull and lock (`lock_fsm_instance`); never push-assign an instance to a named worker. This is what makes restart-safety and horizontal scale free.
- **Backpressure = bounded fleet.** Concurrency is capped by fleet size × per-worker concurrency, itself capped by pool/pooler capacity (ADR-004 §Backpressure). Prefer bounding here over unbounded process spawning.
- **Fault isolation per tier** (ADR-003): an actor crash must not kill the orchestrator; an orchestrator crash must release leases (it does — `cleanup()`/visibility timeout).
- **Observability:** propagate `instance_id` + `correlation_id` through every queue hop for end-to-end tracing across languages.
- **Separate scaling axes:** API, orchestrator fleet, and each language's activity fleet scale independently. None should force-scale another.
- **Keep PG the source of truth** (matches CLAUDE.md): state/locks/queues stay in PG; compute fleets are stateless and disposable.

---

## 5. Concrete changes from the current code

1. **Dispatcher** (`run-fsm-dispatch-daemon.ts`): stop spawning a child process per message. Convert to a bounded in-process concurrency pool that leases instances and runs them on the standing fleet. Reuse one `Pool` for the whole process. **✅ DONE (2026-06-14):** dispatcher now uses a `Semaphore(maxConcurrency)` + shared pool, leases via in-process `startFSMWorkerWithDBLock`, wires the pg `fsm_worker_stop` LISTEN to per-instance abort, dedups already-leased instances, and drains on shutdown. CLI gains `-m/--max-concurrency` (default 8); pool `max = maxConcurrency + 4` to cover the dedicated LISTEN connection (`daemon.ts`).
2. **Orchestrator** (`fsmworker.ts`): on `xstate.invoke`, enqueue an activity task instead of relying on in-process actor import. (Promise-worker plumbing already exists — repoint it at a language-neutral consumer.) **↩️ REVERTED (2026-06-23) — not started.** A first cut of the Activity Gateway was prototyped on 2026-06-14 (option B) and then **discarded as too complex for now**; the orchestrator still uses the in-process TS promise worker. See "Reverted work" below.
3. **Actors:** move from `import()` of `typescript/actors/index.ts` to per-language activity-worker fleets keyed by a compiler-maintained registry. Add `python/`, `rust/` sibling folders. **↩️ REVERTED (2026-06-23) — not started.** The 2026-06-14 prototype (wire contract, TS worker SDK, Python reference worker) was **discarded as too complex for now**. Actors remain in-process TS via dynamic `import()`. See "Reverted work" below.
4. **Connection strategy:** introduce PgBouncer/Supavisor; shrink per-worker `Pool.max`; give the `LISTEN` consumer a dedicated session connection; ensure polyglot actor workers reach the queue via gateway/broker, not a direct PG pool. **◐ PARTIAL (2026-06-14):** the dispatcher pool is sized to the fleet, and the `LISTEN` consumer already uses a dedicated never-released connection (`pg-listener-for-worker-stop-event.ts`). *Remaining:* the polyglot-worker-via-gateway piece (reverted with items 2–3); and run PgBouncer/Supavisor in transaction mode in front of Postgres (infra/deploy, not code).
5. **Keep:** ADR-004 dispatch queue, `lock_fsm_instance` atomic lease, watchdog recovery scan — these are correct.

### Reverted work — Activity Gateway prototype (2026-06-14 → discarded 2026-06-23)

The Activity Gateway slice (KB §3.3 option B) was prototyped and then reverted as too complex for now. **What was removed:**

- `apps/fsm-core-worker-ts/src/activity/` — `contract.ts`, `gateway.ts`, `worker-sdk.ts`, `README.md`
- `apps/fsm-core-worker-ts/src/cli/activity-gateway.ts`, `apps/fsm-core-worker-ts/src/cli/activity-worker.ts`
- `apps/fsm-core-worker-ts/clients/python/activity_worker.py`
- `deno.json` tasks `activity-gateway` / `activity-worker`
- `index.ts` activity exports
- The `buildPromiseArchiveData` extraction in `fsmpromiseworker-helper.ts` (reverted to its original self-contained `processFSMPromiseQueueMessage`)

**Kept (NOT reverted):** the dispatcher bounded-fleet refactor (item 1) and the dispatcher-side connection facts in item 4.

**To resume later:** re-extract `buildPromiseArchiveData` as the shared poll→complete mapping, then rebuild the gateway (owns the only pool) + a TS/Python worker SDK against it. The previous wire contract was: `POST /activity/poll | /activity/complete | /activity/fail` with `{ taskToken, actor, input, instanceId, correlationId }`. Consider doing the compiler-maintained actor registry first so descriptors are generated, not hand-declared.

---

## 6. Prior art to mirror

- **Temporal** — workflow (orchestrator) vs activity (polyglot worker); bounded worker fleets polling task queues; per-worker multiplexing of many executions.
- **AWS Step Functions** — state machine vs "activity workers" (any language) that poll for tasks and return results.
- **Cadence / Netflix Conductor** — same orchestrator/worker split with polyglot SDKs.

The chosen design = Temporal's model, with **Postgres + pgmq as the task-queue substrate** instead of a dedicated server.
