# ADR-004: FSM Worker Dispatch Strategy — Master Dispatch Queue via pgmq

**Status:** Accepted  
**Date:** 2026-06-11

---

## Context

When a new FSM instance is created via `POST /fsm/instances`, a worker must be started to poll its pgmq queue and drive the FSM forward. The `fsm_instance_id` returned by `createFsmInstanceFromName()` is the queue name.

Two dispatch strategies were evaluated:

### Option A — Periodic table scan (watchdog)

A daemon polls `fsm_instance` periodically, finds rows with `worker_locked = false` (or null), and starts a worker for each. This is possible now that lock state lives directly in `fsm_instance` (see ADR-003 / migration `20260611000000`).

**Problems:**
- Latency is bounded by the scan interval. A newly created instance waits up to N seconds before a worker picks it up.
- Multiple scanner processes (horizontal scale) see the same unlocked rows simultaneously, causing a race to acquire locks and wasted work.
- Scans grow costlier as `fsm_instance` accumulates rows without careful filtering/indexing.
- Scan interval is a constant tradeoff: too short = unnecessary DB load; too long = high latency.

**Role:** Useful only as a secondary safety net / recovery mechanism to catch instances whose dispatch message was lost. Not suitable as the primary dispatch path.

### Option B — Master dispatch queue via pgmq (chosen)

`createFsmInstanceFromName()` (or the API handler calling it) pushes `{ fsm_instance_id }` onto a dedicated `worker_dispatch` pgmq queue immediately after creating the instance. A long-running daemon service polls this queue and calls `startFSMWorkerWithDBLock(fsm_instance_id, ...)` for each message it dequeues.

---

## Decision

We will use **Option B — a `worker_dispatch` pgmq queue** as the primary worker dispatch mechanism.

### Flow

```
POST /fsm/instances
  → createFsmInstanceFromName()         creates fsm_instance row (worker_locked = false)
  → pgmq.send("worker_dispatch", { fsm_instance_id, fsm_name, fsm_version })
  → return { fsm_instance_id }          API done — no worker lifecycle in-process

Dispatcher daemon (standalone process, always running):
  → loop: pgmq.read("worker_dispatch", vt=60)
  → for each message: startFSMWorkerWithDBLock(fsm_instance_id, fsm_name, fsm_version, ...)
  → worker runs until FSM reaches terminal state or stop signal
  → pgmq message archived on successful worker start (lock acquired)
  → message re-appears after vt if dispatcher crashes before acquiring lock
```

The `worker_dispatch` queue carries the minimum payload needed to start a worker: `fsm_instance_id`, `fsm_name`, `fsm_version`, and the path to the verified module. The dispatcher calls `bootstrapFsmModules()` at startup to pre-load all verified modules, so individual dispatch messages do not need to carry module config.

### Concurrency safety

`lock_fsm_instance` (now updating `fsm_instance.worker_locked`) uses `UPDATE ... WHERE worker_locked = FALSE OR worker_locked IS NULL`, which is atomic under PostgreSQL's row-level locking. If two dispatcher processes race on the same message, only one will win the `UPDATE`; the other returns `false` and discards the message. The pgmq visibility timeout (vt) provides an additional layer: only one dispatcher holds the message at a time.

### Watchdog scan (Option A as secondary mechanism)

A lightweight periodic scan of `fsm_instance WHERE worker_locked = false AND started_at < now() - interval '2 minutes'` serves as a recovery mechanism only — it catches instances whose dispatch message was lost (dispatcher crash after dequeue but before lock). This scan runs infrequently (every 60–120 seconds) and is not the hot path.

---

## Consequences

### Positive

- **Near-zero dispatch latency** — queue read is triggered immediately; no scan interval overhead.
- **Backpressure control** — the dispatcher controls parallelism: it can start at most N workers concurrently, bounded by DB connection pool capacity.
- **At-least-once delivery** — pgmq's visibility timeout means a crash before lock acquisition causes the message to re-appear automatically.
- **No race between multiple dispatchers** — pgmq `read` is atomic; only one dispatcher dequeues a given message.
- **API stays thin** — the Hono API only creates the instance and enqueues a dispatch message. It has no knowledge of worker lifecycle, `activeWorkers` maps, or `AbortController` instances.
- **Consistent with ADR-003** — workers remain separate processes. The dispatcher is itself a CLI daemon using `bootstrapFsmModules()`.
- **Already on pgmq** — no new infrastructure. `worker_dispatch` is just another queue.

### Negative / Trade-offs

- **Asynchronous by design** — the API cannot return synchronous worker status in the create response. Callers poll `GET /fsm/instances/:id` to observe FSM progress.
- **Dispatcher is a required service** — the system is not fully functional without the dispatcher daemon running. This is an explicit operational dependency.
- **Queue message payload must include routing info** — `fsm_name`, `fsm_version`, and sufficient module context must be in the message so the dispatcher can call `startFSMWorkerWithDBLock` correctly.

---

## Relationship to Other ADRs

- **ADR-003** — established separate-process workers as the production model. This ADR specifies how new work reaches those processes.
- **Migration `20260611000000`** — merged `fsm_instance_lock` into `fsm_instance`. The watchdog scan (Option A, secondary) and the lock check in `lock_fsm_instance` both rely on `fsm_instance.worker_locked` being directly queryable without a join.
