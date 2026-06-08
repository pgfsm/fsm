# FSMWorker Route Design — Current Architecture

## Decision

Worker routes were **merged into `/fsm`** (commit `2d6f83a`). The `/routes/fsmworker/` directory exists but is empty.

`/fsmpromise` remained a separate route prefix (unchanged).

---

## Current Route Surface

| Route | Handler file | Responsibility |
|---|---|---|
| `GET /fsm` | `fsm.handlers.ts` | List all FSM instances from DB |
| `GET /fsm/:id` | `fsm.handlers.ts` | Get single FSM instance + resolved state by ID |
| `POST /fsm` | `fsm.handlers.ts` | Creates FSM instance + starts worker with DB lock |
| `POST /fsm/send` | `fsm.handlers.ts` | Sends event to a running FSM instance |
| `GET /fsm/currentActive` | `fsm.handlers.ts` | Returns active worker locks (in-memory map projection) |
| `POST /fsm/resume` | `fsm.handlers.ts` | Re-attaches worker to an existing stopped instance (state preserved) |
| `POST /fsm/stop` | `fsm.handlers.ts` | Stops a running worker (aborts its AbortController) |
| `GET /fsmpromise` | `fsmpromise.handlers.ts` | Returns active promise workers (in-memory map projection) |
| `POST /fsmpromise/start` | `fsmpromise.handlers.ts` | Starts promise worker for existing queue |
| `POST /fsmpromise/create-and-start` | `fsmpromise.handlers.ts` | Creates PGMQ queue + starts promise worker |
| `POST /fsmpromise/stop` | `fsmpromise.handlers.ts` | Stops a running promise worker |

---

## Resolved Issues

### ~~Issue 1: `GET /fsm` returns the wrong data~~ ✅ Resolved

Handler calls `listFsmInstances()` and returns rows from the `fsm_instance` table. `GET /fsm/currentActive` holds active worker state (in-memory map projection).

`GET /fsm/:id` was added to fetch a single instance by ID via `getFsmDataResolveStateValue()`, returning both the full instance row and the resolved state value.

### ~~Issue 2: `POST /fsm/start` naming~~ ✅ Resolved → renamed to `POST /fsm/resume`

`start` was ambiguous alongside `POST /fsm` (create + start new). `resume` is semantically accurate: the FSM instance state is preserved in DB, and the worker is re-attached to continue processing from that saved state. `restart` was rejected because it implies a state reset (stop + reset + start), which is not what happens here.

The triad is now unambiguous:
- `POST /fsm` — create a new instance and start its worker
- `POST /fsm/resume` — re-attach a worker to an existing stopped instance
- `POST /fsm/stop` — stop a running worker (instance state preserved)

### Issue 3: `activeWorkers` ownership

`activeWorkers` is defined in `fsm.handlers.ts` even though it tracks worker execution state, not FSM instance state. This is a minor conceptual mismatch introduced by the merge.

**Fix (future):** Move `activeWorkers` to a shared module (e.g., `lib/worker-state.ts`) if `fsmworker` routes are ever re-split out, or leave it in `fsm.handlers.ts` as-is since the merge makes it the single handler file.

---

## Pre-merge rationale (for reference)

Before the merge, the recommendation was to keep `/fsmworker` separate from `/fsm` based on separation of concerns (`/fsm` = instance lifecycle, `/fsmworker` = worker process control) and consistency with `/fsmpromise`. The merge was made to simplify the API surface — callers now work with a single `/fsm` prefix for all FSM-related operations.
