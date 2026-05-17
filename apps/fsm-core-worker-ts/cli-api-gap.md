# CLI ↔ API Gap Analysis — fsm-core-worker-ts

This document maps the 5 CLI commands in `src/cli/index.ts` against the HTTP routes in `apps/fsm-core-ts-hono-deno/routes/` and records gaps.

---

## Coverage matrix

| CLI command | Underlying TS function | HTTP route | Status |
|---|---|---|---|
| `start-worker` | `startFSMWorker` | None (closest: `POST /fsmworker` calls `startFSMWorkerWithDBLock`, not `startFSMWorker`) | Partial mismatch |
| `start-worker-with-db-lock` | `startFSMWorkerWithDBLock` | `POST /fsmworker` | Covered |
| `start-promise-worker` | `startFSMPromiseWorker` | `POST /fsmpromise` (broken arg mapping — see below) | Partial / broken |
| `create-and-start-worker` | `createAndStartFSMWorker` | None | **Gap** |
| `create-and-start-promise-worker` | `createAndStartPromiseWorker` | None | **Gap** |

---

## Gap 1 — `start-worker` has no dedicated HTTP route

`POST /fsmworker` always calls `startFSMWorkerWithDBLock`. There is no route that calls the bare `startFSMWorker` (no lock acquisition). This means the CLI and API are not symmetric for the basic worker case.

**File:** `apps/fsm-core-ts-hono-deno/routes/fsmworker/fsmworker.handlers.ts`

**Recommended addition:** Accept an optional `lock: boolean` query param on `POST /fsmworker`, or add a dedicated `POST /fsmworker/no-lock` route that calls `startFSMWorker` directly.

---

## Gap 2 — No HTTP route for `create-and-start-worker`

The CLI supports creating a new FSM instance + queue and immediately starting a worker in one step. No equivalent HTTP endpoint exists.

**Underlying function:** `createAndStartFSMWorker` in `src/createAndStartFSMWorker.ts`

**Recommended addition:**
```
POST /fsmworker/create-and-start
Body: { fsm_name: string, fsm_version: string, fsm_context?: object }
```
Calls `createAndStartFSMWorker(deps, fsm_name, fsm_version, verifiedModule, activeLocks, fsm_context)` and returns the created instance ID.

---

## Gap 3 — No HTTP route for `create-and-start-promise-worker`

The CLI supports creating a PGMQ queue and starting a promise worker in one step. No equivalent HTTP endpoint exists.

**Underlying function:** `createAndStartPromiseWorker` in `src/createAndStartPromiseWorker.ts`

**Recommended addition:**
```
POST /fsmpromise/create-and-start
Body: { queue_name: string, fsm_name: string, promise_type: string, fsm_version: string }
```

---

## Gap 4 — `POST /fsmpromise` has incorrect argument mapping

**File:** `apps/fsm-core-ts-hono-deno/routes/fsmpromise/fsmpromise.handlers.ts`

The handler calls `startFSMPromiseWorker` but maps arguments incorrectly:

```ts
// Current (broken)
startFSMPromiseWorker(
  deps,
  promise_name,         // queueName ✓
  promise_name,         // fsm_promise_name ✓
  input_promise_version // fsm_promise_type ✗ (passing version where type is expected)
  // fsm_promise_version missing entirely
  // verifiedModule missing entirely
)

// startFSMPromiseWorker signature expects:
startFSMPromiseWorker(
  deps,
  queueName,
  fsm_promise_name,
  fsm_promise_type,    // actor/promise type string — distinct from version
  fsm_promise_version, // version string
  verifiedModule?,
  signal?
)
```

**Fix required:** The route handler needs to accept and pass `promise_type` and `promise_version` as separate fields, and load a `verifiedModule` from a folder path or registry.

---

## Summary of recommended additions

| New endpoint | Maps to | Priority |
|---|---|---|
| `POST /fsmworker/create-and-start` | `createAndStartFSMWorker` | High |
| `POST /fsmpromise/create-and-start` | `createAndStartPromiseWorker` | High |
| Fix `POST /fsmpromise` arg mapping | `startFSMPromiseWorker` | High (current impl is broken) |
| `POST /fsmworker` with `lock=false` option | `startFSMWorker` | Low |
