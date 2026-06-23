# ADR-003: FSM Worker Process Model — Separate Process vs In-Process Async Function

**Status:** Accepted  
**Date:** 2026-06-11

---

## Context

The FSM system has two execution paths for starting workers:

1. **In-process async** — The Hono API handler (`fsm.handlers.ts`) calls `createAndStartFSMWorker()`, which creates an FSM instance and immediately starts a polling loop as a fire-and-forget Promise within the same API server process. The loop runs until signalled via `AbortController`.

2. **Separate process (CLI)** — `apps/fsm-core-worker-ts/src/cli/index.ts` bootstraps modules, connects to the DB, and runs one worker as a long-running daemon process managed by the OS (SIGINT/SIGTERM).

The question is: for production and distributed scale, which model should be used to start FSM workers in response to API requests?

The core flow is:
- `POST /fsm/instances` creates an FSM instance via `createFsmInstanceFromName()`, which generates a `fsm_instance_id` that doubles as the pgmq queue name.
- A worker must poll that queue to drive the FSM forward.

---

## Decision

We will use the **separate process model** for production worker execution.

The Hono API is responsible only for:
1. Creating the FSM instance (and its pgmq queue) via `createFsmInstanceFromName()`.
2. Returning the `fsm_instance_id` to the caller.

Worker execution is handled by **standalone CLI processes** (`fsm-core-worker-ts`) that are deployed and managed independently — via Kubernetes Deployments, systemd, PM2, or equivalent. These processes run `bootstrapFsmModules()` at startup and then call `startFSMWorkerWithDBLock(fsm_instance_id, ...)`.

The pgmq queue is the decoupling boundary. The API pushes work onto it; workers consume from it. The API does not start, stop, or track workers directly.

---

## Consequences

### Positive

- **Fault isolation** — A worker crash or memory leak does not affect the API server or other workers. Each worker process is independently restartable.
- **Independent scaling** — Workers and the API scale separately. High FSM throughput does not require scaling the HTTP tier, and vice versa.
- **OS/orchestrator lifecycle management** — Kubernetes, systemd, and PM2 can restart crashed workers, enforce resource limits (CPU/memory), and provide health checks without application-level plumbing.
- **Aligns with Temporal's worker model** — Temporal workers are separate long-running daemon processes that poll task queues. Our CLI-based workers follow the same pattern: bootstrap, connect, poll, process, repeat.
- **No in-process state leakage** — The `activeWorkers` in-memory map (currently in `fsm.handlers.ts`) is only needed for the in-process model. With separate processes, worker state lives in the DB (pgmq queue + advisory lock), not in application memory.
- **Restart safety** — Because `startFSMWorkerWithDBLock` uses a PostgreSQL advisory lock, restarting a crashed worker process is safe — the new process acquires the lock and resumes from the queue without duplicating work.

### Negative / Trade-offs

- **More infrastructure** — Requires a process manager or orchestrator. A bare `deno run` of the API server is no longer sufficient to run the full system.
- **No immediate worker feedback** — The API cannot synchronously wait for a worker result within the same HTTP request. Callers must poll the FSM instance state separately.
- **Queue name must be communicated** — The caller receives `fsm_instance_id` from the create API and must pass it to the worker process (via the CLI `-q` flag, a job queue, or pg_notify dispatch).

### Transition note

The current in-process path (`createAndStartFSMWorker` called from `fsm.handlers.ts`) remains for development and single-machine use. For production deployments, the `create` handler should call only `createFsmInstanceFromName()` and return the `fsm_instance_id`; worker startup is handled out-of-band by CLI daemon processes.

---

## Alternatives Considered

### Fork / child_process / Deno.Command

Spawning a child process from within the API handler when a new FSM instance is created. Rejected because:
- It couples the API process to worker lifecycle management — the API must track PIDs, handle crashes, and clean up zombie processes.
- Forks inherit the parent's file descriptors and memory, complicating resource management.
- An orchestrator (Kubernetes) already provides this capability more reliably at the infrastructure level.

### In-process async (current development path)

Keeping workers as async Promises inside the API process. Acceptable for development but rejected for production because:
- API crashes kill all running workers.
- No independent scaling.
- `activeWorkers` in-memory map is lost on restart with no recovery path.
- Blocks clean horizontal scaling behind a load balancer (workers are tied to one instance).
