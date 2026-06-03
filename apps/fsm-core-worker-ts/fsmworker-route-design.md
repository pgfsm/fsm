# FSMWorker Route Design — Current Architecture

## Decision

Worker routes were **merged into `/fsm`** (commit `2d6f83a`). The `/routes/fsmworker/` directory exists but is empty.

`/fsmpromise` remained a separate route prefix (unchanged).

---

## Current Route Surface

| Route | Handler file | Responsibility |
|---|---|---|
| `GET /fsm` | `fsm.handlers.ts` | ⚠️ Returns activeWorkers (wrong — should return FSM instances from DB) |
| `POST /fsm` | `fsm.handlers.ts` | Creates FSM instance + starts worker with DB lock |
| `POST /fsm/send` | `fsm.handlers.ts` | Sends event to a running FSM instance |
| `GET /fsm/currentActive` | `fsm.handlers.ts` | Returns active worker locks (in-memory map projection) |
| `POST /fsm/start` | `fsm.handlers.ts` | Starts worker for an existing FSM instance (with DB lock) |
| `POST /fsm/stop` | `fsm.handlers.ts` | Stops a running worker (aborts its AbortController) |
| `GET /fsmpromise` | `fsmpromise.handlers.ts` | Returns active promise workers (in-memory map projection) |
| `POST /fsmpromise/start` | `fsmpromise.handlers.ts` | Starts promise worker for existing queue |
| `POST /fsmpromise/create-and-start` | `fsmpromise.handlers.ts` | Creates PGMQ queue + starts promise worker |
| `POST /fsmpromise/stop` | `fsmpromise.handlers.ts` | Stops a running promise worker |

---

## Open Design Issues

These problems were identified when the routes were merged and are deferred to a future session.

### Issue 1: `GET /fsm` returns the wrong data

`GET /fsm` currently returns `activeWorkers` (the in-memory map of running workers). It should return a list of FSM instances from the `fsm_instance` table. Active worker state belongs exclusively on `GET /fsm/currentActive`, which was added as the correct home for that data.

**Fix (future):**
- `GET /fsm` → query `fsm_instance` table via `listFsmInstances()` and return rows
- `GET /fsm/currentActive` → returns `activeWorkers` projection (already correct)

### Issue 2: `activeWorkers` ownership

`activeWorkers` is defined in `fsm.handlers.ts` even though it tracks worker execution state, not FSM instance state. This is a minor conceptual mismatch introduced by the merge.

**Fix (future):** Move `activeWorkers` to a shared module (e.g., `lib/worker-state.ts`) if `fsmworker` routes are ever re-split out, or leave it in `fsm.handlers.ts` as-is since the merge makes it the single handler file.

---

## Pre-merge rationale (for reference)

Before the merge, the recommendation was to keep `/fsmworker` separate from `/fsm` based on separation of concerns (`/fsm` = instance lifecycle, `/fsmworker` = worker process control) and consistency with `/fsmpromise`. The merge was made to simplify the API surface — callers now work with a single `/fsm` prefix for all FSM-related operations.
