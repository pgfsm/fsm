# ADR-001: FSM Worker Execution Model Evolution

| Field    | Value                                                                            |
| -------- | -------------------------------------------------------------------------------- |
| Status   | Current (Stage 3 is active)                                                      |
| Date     | 2026-06-30                                                                       |
| Deciders | Niraj                                                                            |
| Affects  | `apps/fsm-core-worker-ts`, `apps/fsm-core-ts-hono-deno`, `packages/database-src` |

---

## Context

This record documents the evolution of how FSM instance workers and promise
actor workers are executed and managed. The system progressed through three
distinct stages, each addressing production concerns that the previous stage
left unsolved.

The core problem: given that FSM instances are created via an HTTP API, how
should the lifecycle of the worker that drives each FSM instance be managed — in
terms of isolation, scalability, routing, and backpressure?

---

## Stage 1 — In-Process Model (Thick Client)

### What it was

FSM instance workers and promise actor workers ran **inside the same OS process
as the HTTP API server**. When a request hit `POST /fsm/create`, the API handler
would:

1. Create the FSM instance in PostgreSQL.
2. Immediately start an in-process worker (via `createAndStartFSMWorker`) on the
   same event loop.
3. Track it in a module-level `activeWorkers` map.

The API server was also the worker runtime. There was no separation between
request-handling and long-running FSM execution.

**Key files (still present as the in-process route handlers):**

- `fsm.handlers.inprocess.ts` — `createAndStart`, `resumeWithWorker`,
  `currentActive`
- `create-and-start-fsm-worker.ts`

### Why it was not suitable for production

| Problem                        | Impact                                                                                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No isolation**               | A single long-running or crashed FSM worker could starve the API event loop, causing request timeouts for unrelated traffic.                                                       |
| **Memory pressure**            | Many concurrent in-process workers (each holding XState machine state, pending timers, and DB connections) would cause OOM on the API process with no way to shed load gracefully. |
| **No independent scaling**     | Workers and the API scaled together. A CPU-heavy FSM workload forced scaling up the entire API tier.                                                                               |
| **No routing**                 | Every API replica ran every FSM type. There was no way to assign specific FSM types to dedicated worker processes.                                                                 |
| **Restarts kill live workers** | A rolling API deploy would abort all in-flight FSM instances with no recovery path.                                                                                                |

---

## Stage 2 — Pull-Based Staging Queue (First Thin Client Layer)

### What it was

FSM execution moved out of the API process. The API handler became a thin
writer: it created the FSM instance and enqueued a message to a global pgmq
queue (`master_worker_dispatch_queue_start`). A separate **daemon process**
(`runFsmDispatchDaemon`) polled that queue and spawned in-process workers for
each dequeued message.

```
HTTP API                         Daemon process
─────────                        ──────────────
POST /fsm/create                 while true:
  → INSERT fsm_instance            msg = pgmq.read(master_worker_dispatch_queue_start)
  → pgmq.send(start_queue, id)     startFSMWorkerWithDBLock(msg.id, ...)
```

A semaphore (`maxConcurrency`) bounded how many FSM workers ran concurrently
within one daemon. A `pgListenerForWorkerStopEvent` connection let the API
signal individual workers to stop via `pg_notify('fsm_worker_stop', id)`.

**Key file:** `run-fsm-dispatch-daemon.ts` (now `fsmlet.ts`)

### What was good

- API process no longer ran FSM workers — clean separation.
- pgmq provided durable queueing with visibility timeout (messages reappeared if
  the daemon crashed mid-flight).
- A single shared pg Pool per daemon kept connection count bounded.

### What was missing (not implemented)

**Backpressure was only half-solved.** The semaphore stopped the daemon from
running more than `maxConcurrency` workers simultaneously, but the daemon would
still dequeue messages from pgmq even when close to capacity — it just held them
in-flight under the VT. If the daemon was restarted while near-full, those
messages would reappear correctly, but there was no mechanism to:

- **Stop pulling when memory pressure was high** — the daemon had no awareness
  of system memory or its own heap usage. Under sustained load it would continue
  accepting new workers until OOM.
- **Report capacity back to any orchestrator** — there was no registry. The
  daemon did not publish how many slots it had free.

**Routing was global and unaware.** All daemon instances (if running more than
one) competed for the same single queue. There was no way to:

- Route FSM type X only to a daemon that had that FSM module loaded and
  validated.
- Prefer a daemon with more available concurrency slots.
- Know which daemon was handling which instance.

**No heartbeat or health model.** If a daemon died silently, the pgmq VT would
eventually expire and messages would reappear, but there was no liveness signal
and no way for the API to know how many healthy workers were available.

**Two global queues added complexity.** Resume operations went to a separate
`master_worker_dispatch_queue_resume` queue. The daemon ran two parallel polling
loops over structurally identical work — the distinction between start and
resume was meaningful to the API writer but not to the daemon reader.

### TODO — Single queue + self-aware pull loop

**1. Merge start and resume into a single queue.**

The daemon reader does not behave differently for start vs resume — both call
`startFSMWorkerWithDBLock`. The split existed because the API writer wanted to
distinguish them semantically, but that distinction can be carried as a
`dispatch_type` field in the message payload rather than as two separate queues.
A single `master_worker_dispatch_queue` with `dispatch_type: 'start' | 'resume'`
would:

- Halve the number of pgmq tables.
- Replace two polling loops with one, removing the implicit ordering ambiguity
  (the two loops compete for the shared semaphore in unpredictable order under
  burst load).
- Preserve the semantic distinction for logging and debugging via the payload
  field.

**2. Add self-aware guard checks inside the pull loop before every
`readMessage`.**

The current loop acquires the semaphore and immediately reads from the queue,
relying entirely on the semaphore count as the backpressure signal. The loop
should also check runtime health before pulling, so a daemon under stress stops
accepting new work before it becomes a problem rather than after:

```typescript
// Proposed guard inside the while loop (before readMessage)
const shouldPull = (): boolean => {
  // Guard 1: concurrency — don't pull if all slots are taken.
  // (Already enforced by semaphore acquire, but explicit check avoids
  //  a spurious DB round-trip when the semaphore would immediately block.)
  if (activeWorkers.size >= maxConcurrency) return false;

  // Guard 2: memory — don't pull if heap usage is above a threshold.
  // Deno: Deno.memoryUsage().heapUsed / Deno.memoryUsage().heapTotal
  // Node: process.memoryUsage().heapUsed / process.memoryUsage().heapTotal
  const mem = Deno.memoryUsage();
  const heapRatio = mem.heapUsed / mem.heapTotal;
  if (heapRatio > MAX_HEAP_RATIO) { // e.g. 0.80
    logger.warning("Heap pressure ({ratio}%) — pausing pull", {
      ratio: (heapRatio * 100).toFixed(1),
    });
    return false;
  }

  return true;
};

// Inside the loop:
while (!signal?.aborted) {
  await sem.acquire();
  if (!shouldPull()) {
    sem.release();
    await sleep(BACKPRESSURE_PAUSE_MS); // e.g. 2000 ms, then re-check
    continue;
  }
  // ... readMessage, startWorker ...
}
```

**Why this matters:** The semaphore prevents running more than `maxConcurrency`
workers, but it does not prevent the daemon from _pulling_ a message and then
blocking on `sem.acquire()` while holding the pgmq VT. If the daemon is at
capacity and still pulls, the message becomes invisible to other daemons for the
VT duration — effectively starving other potential consumers. The guard ensures
the daemon only pulls when it can actually start the work immediately.

The memory guard is a secondary safety net: even if `maxConcurrency` slots are
technically free, a daemon with a heap near exhaustion should refuse new work
before the OS kills the process, giving in-flight workers time to complete.

### Codebase changes needed to explore this path

The Stage 2 daemon (`run-fsm-dispatch-daemon.ts`) was superseded by Stage 3
(`fsmlet.ts`). To explore these improvements, branch from the last git commit
that still contained the Stage 2 daemon, or create a new experimental file. The
concrete changes are:

**A. SQL — merge queues (`packages/database-src/supabase/schemas/`)**

In `20250119124637_fsm_scheduler_dispatch.sql`, update `enqueue_fsm_dispatch_v1`
to send to a single queue:

```sql
-- Replace the two-queue send in enqueue_fsm_dispatch_v1 with:
PERFORM pgmq.send(
    queue_name := 'master_worker_dispatch_queue',
    msg        := jsonb_build_object(
        'id',            input_instance_id,
        'fsm_name',      input_fsm_name,
        'fsm_version',   input_fsm_version,
        'dispatch_type', input_dispatch_type   -- 'start' | 'resume'
    )
);
```

Add a new migration to create the single queue and drop the two old ones:

```sql
-- new migration file e.g. 20260630000001_fsm_merge_dispatch_queues.sql
SELECT pgmq.create('master_worker_dispatch_queue');
SELECT pgmq.drop_queue('master_worker_dispatch_queue_start');
SELECT pgmq.drop_queue('master_worker_dispatch_queue_resume');
```

**B. Daemon constants — single queue
(`apps/fsm-core-worker-ts/src/run-fsm-dispatch-daemon.ts` or new experimental
file)**

Remove the two queue constants and replace with one:

```typescript
// Before
const DISPATCH_QUEUE_START = "master_worker_dispatch_queue_start";
const DISPATCH_QUEUE_RESUME = "master_worker_dispatch_queue_resume";

// After
const DISPATCH_QUEUE = "master_worker_dispatch_queue";
const MAX_HEAP_RATIO = 0.80;
const BACKPRESSURE_PAUSE_MS = 2_000;
```

**C. Daemon loop — replace two parallel loops with one**

```typescript
// Before
await Promise.all([
  runDispatchLoop(DISPATCH_QUEUE_START),
  runDispatchLoop(DISPATCH_QUEUE_RESUME),
]);

// After
await runDispatchLoop(DISPATCH_QUEUE);
```

**D. `runDispatchLoop` — add `shouldPull` guard before `readMessage`**

Inside the existing `runDispatchLoop` function, before the `readMessage` call,
add:

```typescript
// Add at top of runDispatchLoop (after constants):
const shouldPull = (): boolean => {
  if (activeWorkers.size >= maxConcurrency) return false;
  const mem = Deno.memoryUsage();
  if (mem.heapUsed / mem.heapTotal > MAX_HEAP_RATIO) {
    logger.warning("Heap {ratio}% — pausing pull", {
      ratio: ((mem.heapUsed / mem.heapTotal) * 100).toFixed(1),
    });
    return false;
  }
  return true;
};

// In the while loop, replace:
//   await sem.acquire();
//   const messages = await readMessage(...);
// With:
while (!signal?.aborted) {
  if (!shouldPull()) {
    await sleep(BACKPRESSURE_PAUSE_MS);
    continue;
  }
  await sem.acquire();
  if (signal?.aborted) {
    sem.release();
    break;
  }
  const messages = await readMessage(deps, DISPATCH_QUEUE, vt);
  // ... rest unchanged
}
```

Note: `shouldPull` is checked _before_ `sem.acquire()` so a heap-pressured
daemon never blocks on the semaphore while holding a pulled message under VT.

**E. `fsmctl.ts` and `fsm.handlers.dispatch.ts` — resume no longer needs a
separate queue**

Both callers of `enqueue_fsm_dispatch_v1` (for Stage 2) would simply pass
`dispatch_type: 'resume'` and write to the same queue name. No routing change in
application code — only the queue name constant changes.

**F. `cli/worker.ts` — `create-and-start-promise-worker` command is unaffected**

Promise actor workers use their own per-actor pgmq queues (not the dispatch
queue). No changes needed there.

---

## Stage 3 — Kubernetes-Style Scheduler Model (Current)

### Motivation

Stages 1 and 2 mapped to the following Kubernetes analogy:

| Kubernetes component | Stage 2 equivalent                                   | Stage 3 equivalent                       |
| -------------------- | ---------------------------------------------------- | ---------------------------------------- |
| `kube-apiserver`     | HTTP API                                             | HTTP API + `fsmctl`                      |
| `etcd`               | PostgreSQL                                           | PostgreSQL                               |
| `kube-scheduler`     | _(absent — global queue was the implicit scheduler)_ | `fsmscheduler` process                   |
| `kubelet`            | Daemon (pull-based, self-scheduling)                 | `fsmlet` (push-notified, pre-registered) |

The critical insight from Kubernetes: **the scheduler and the node agent are
separate components**. The node agent (kubelet / fsmlet) should not decide what
to run — it should only run what the scheduler assigns to it. The scheduler
needs a cluster-wide view of node capacity and should make placement decisions
centrally.

### Architecture

Three components, one PostgreSQL database, two pg_notify channels per fsmlet:

```
┌─────────────────────────────────────────────────────────────┐
│  Control Plane                                              │
│                                                             │
│  HTTP API (fsm.handlers.dispatch.ts)                        │
│  fsmctl (cli/fsmctl.ts)                                     │
│    │                                                        │
│    │ fsm_core.enqueue_fsm_dispatch_v2()                     │
│    │   INSERT INTO fsm_dispatch_queue (status='pending')    │
│    │   pg_notify('fsm_scheduler_work', instance_id)         │
│    ▼                                                        │
│  fsmscheduler (scheduler/fsm-scheduler.ts)                  │
│    LISTEN 'fsm_scheduler_work'                              │
│    → fsm_core.schedule_next_pending()                       │
│         SELECT FOR UPDATE SKIP LOCKED pending entry         │
│         JOIN fsm_daemon_node WHERE                          │
│           heartbeat fresh AND has module AND has free slot  │
│         ORDER BY (max_concurrency - active_workers) DESC    │
│         UPDATE fsm_dispatch_queue SET status='scheduled'    │
│         pg_notify('fsm_fsmlet_work_<id>', instance_id)      │
└─────────────────────────────────────────────────────────────┘
              │ pg_notify per fsmlet
              ▼
┌─────────────────────────────────────────────────────────────┐
│  Worker Nodes (one fsmlet process per node)                 │
│                                                             │
│  fsmlet (fsmlet.ts)                                         │
│    LISTEN 'fsm_fsmlet_work_<daemon_id>'                     │
│    LISTEN 'fsm_worker_stop'                                 │
│    → claimScheduledForFsmlet()                              │
│         SELECT FOR UPDATE SKIP LOCKED WHERE                 │
│           status='scheduled' AND scheduled_fsmlet_id=me     │
│         DELETE row (dispatch entry gone on claim)           │
│    → startFSMWorkerWithDBLock(instance_id, ...)             │
│    → fsmletHeartbeat() every 5 s                            │
│         UPDATE fsm_daemon_node SET                          │
│           active_workers=N, last_heartbeat=NOW()            │
└─────────────────────────────────────────────────────────────┘
```

### Database tables

| Table                         | Purpose                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `fsm_core.fsm_dispatch_queue` | Dispatch entries: `pending` → `scheduled` → _(deleted on claim)_                                   |
| `fsm_core.fsm_daemon_node`    | Fsmlet registry: `daemon_id`, `fsm_modules`, `max_concurrency`, `active_workers`, `last_heartbeat` |

### Key PostgreSQL functions

| Function                                  | Role                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `fsm_core.enqueue_fsm_dispatch_v2`        | INSERT + pg_notify scheduler — replaces pgmq send                        |
| `fsm_core.schedule_next_pending`          | SELECT FOR UPDATE SKIP LOCKED + filter/score + UPDATE + pg_notify fsmlet |
| `fsm_core.resume_event_for_fsm_worker_v2` | Lookup fsm_name/version + enqueue_fsm_dispatch_v2 in one call            |
| `fsm_core.stop_event_for_fsm_worker_v2`   | DELETE from fsm_dispatch_queue — cancels pre-claim; no pg_notify needed  |

### What Stage 3 solves that Stage 2 did not

**Backpressure is real.** The scheduler reads `active_workers` and
`max_concurrency` from `fsm_daemon_node` before assigning. A fsmlet at capacity
is simply not selected — no messages are routed to it. Backpressure is enforced
at assignment time by the scheduler, not by the worker trying to self-limit
after already dequeuing.

**Routing is correct.** The scheduler filters on
`fsm_modules @> [{fsmName, fsmVersion}]` — an FSM instance is only routed to a
fsmlet that has that module loaded and verified. A fsmlet that hasn't loaded
`creditCheck_v2` will never receive a `creditCheck_v2` instance.

**No competing consumers on global queues.** Each fsmlet listens on
`fsm_fsmlet_work_<daemon_id>` — its own channel. There is no global queue for
fsmlets to race on. The scheduler is the only writer to the fsmlet's assigned
work; `SELECT FOR UPDATE SKIP LOCKED` is only needed for multi-scheduler HA
safety, not for multi-consumer dispatch.

**Liveness is monitored.** The 5-second heartbeat updates `last_heartbeat`. The
scheduler ignores nodes where `last_heartbeat > 30s ago`. A dead fsmlet stops
receiving work automatically; its pending dispatch entries remain in the table
and are retried on the next scheduler cycle against a live fsmlet.

**Clean shutdown.** On `SIGTERM`, the fsmlet sets its abort signal, drains
in-flight workers, then `DELETE FROM fsm_daemon_node WHERE daemon_id=me`. The
scheduler immediately stops routing to it.

**Single source of truth.** `fsm_dispatch_queue` is the authoritative state of
unstarted and pre-claim work. `fsm_instance` remains the authoritative state of
running and completed FSM lifecycle. No intermediate pgmq staging tables.

### Trade-offs and limitations

- The fsmscheduler must run alongside the API server on the control plane. It is
  not embedded in the fsmlet — this is intentional (mirrors kube-scheduler on
  the master, not kubelet on the node).
- If all fsmlets are at capacity or none have the required module, dispatch
  entries remain `pending` until the next scheduler cycle (fallback poll: 30 s).
  There is currently no alerting on stuck pending entries.
- `SELECT FOR UPDATE SKIP LOCKED` in `schedule_next_pending` serialises
  concurrent schedulers on a per-entry basis — correct, but high throughput may
  require scheduler sharding by FSM type in the future.

### TODO — Explore eliminating the application-level fsmscheduler

**Idea:** Fold the `schedule_next_pending` call directly into
`enqueue_fsm_dispatch_v2` at the PostgreSQL level, removing the need for a
standing fsmscheduler process in the application layer entirely.

**Current flow (3 hops):**

```
enqueue_fsm_dispatch_v2
  → INSERT fsm_dispatch_queue (status='pending')
  → pg_notify('fsm_scheduler_work')           ← hop 1: notify app process
      └─ fsmscheduler LISTEN handler wakes
           → schedule_next_pending()           ← hop 2: app calls back into PG
                → UPDATE + pg_notify fsmlet   ← hop 3: notify fsmlet
```

**Proposed flow (1 hop):**

```
enqueue_fsm_dispatch_v2
  → INSERT fsm_dispatch_queue (status='pending')
  → PERFORM fsm_core.schedule_next_pending()  ← inline PG call
       → UPDATE + pg_notify fsmlet            ← single hop to fsmlet
```

**Why this would work:** Within the same PL/pgSQL call, the newly inserted row
is visible to `schedule_next_pending`'s `SELECT FOR UPDATE SKIP LOCKED` (it is
our own transaction's row — SKIP LOCKED only skips rows locked by _other_
transactions). The scheduling logic, the UPDATE, and the fsmlet `pg_notify` all
happen atomically in the transaction that created the dispatch entry.

**What this eliminates:**

- The `fsmscheduler` application process entirely — no LISTEN loop, no fallback
  poll, no separate deployment.
- The `pg_notify('fsm_scheduler_work')` / `LISTEN 'fsm_scheduler_work'` channel.
- One full application round-trip (INSERT → notify app → app calls PG → PG
  notifies fsmlet becomes INSERT → PG notifies fsmlet).

**Risk — synchronous scheduling on the enqueue hot path:** If
`schedule_next_pending` is slow (e.g. many fsmlets to score, or lock contention
under burst), it blocks the caller's transaction for the duration. Under high
enqueue throughput this could be a bottleneck. The current two-process model
decouples enqueue latency from scheduling latency.

**Explore: PostgreSQL 18 async execution** to call `schedule_next_pending`
non-blocking from within `enqueue_fsm_dispatch_v2`. PostgreSQL 18 introduced
improvements to async query execution at the protocol level. Two angles to
investigate:

1. **`pg_background` / background worker trigger** — call
   `schedule_next_pending` in a background worker spawned by the enqueue
   transaction, so the caller's transaction commits immediately and scheduling
   runs asynchronously. This preserves the single-hop fsmlet notify while
   removing the blocking risk.

2. **PostgreSQL 18 pipeline mode + async functions** — PostgreSQL 18's extended
   query pipeline improvements allow fire-and-forget style calls. Investigate
   whether a deferred or pipelined `PERFORM schedule_next_pending()` could be
   issued after the INSERT commits, avoiding the synchronous coupling while
   still staying inside PostgreSQL.

**Decision gate:** Benchmark `schedule_next_pending` latency at P99 under
realistic fsmlet fleet size (10–50 nodes). If it stays under 5 ms, inline
synchronous call is acceptable and eliminates the entire fsmscheduler process.
If it exceeds that, the PostgreSQL 18 async path is the right direction.

---

## Decision

Stage 3 is the active model. Stages 1 and 2 code is retained as the in-process
route handlers (`fsm.handlers.inprocess.ts`) for development/debugging use but
is not the production dispatch path.

The production dispatch path is:

```
fsmctl / HTTP API  →  fsm_dispatch_queue  →  fsmscheduler  →  fsmlet
```
