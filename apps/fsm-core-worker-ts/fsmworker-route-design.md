# FSMWorker Route Design — Separate vs. Merged

## Question

Should `apps/fsm-core-ts-hono-deno/routes/fsmworker/` be a separate route module, or should its handlers be merged into `routes/fsm/`?

---

## Current Route Surface

| Route | Handler file | Responsibility |
|---|---|---|
| `GET /fsm` | `fsm.handlers.ts` | Returns active FSM locks (⚠️ wrong — see issue below) |
| `POST /fsm` | `fsm.handlers.ts` | Creates FSM instance + starts worker |
| `POST /fsm/send` | `fsm.handlers.ts` | Sends event to a running FSM instance |
| `GET /fsmworker` | `fsmworker.handlers.ts` | Returns active FSM worker locks |
| `POST /fsmworker` | `fsmworker.handlers.ts` | Starts worker for an existing FSM instance |
| `POST /fsmworker/create-and-start` | `fsmworker.handlers.ts` | Creates instance + starts worker |
| `GET /fsmpromise` | `fsmpromise.handlers.ts` | Returns active promise worker locks |
| `POST /fsmpromise` | `fsmpromise.handlers.ts` | Starts promise worker for existing queue |
| `POST /fsmpromise/create-and-start` | `fsmpromise.handlers.ts` | Creates queue + starts promise worker |

---

## Recommendation: Keep fsmworker as a **separate route**

### Rationale

**1. Separation of concerns**
- `/fsm` → FSM instance lifecycle: creating instances and sending events to them
- `/fsmworker` → Worker process control: attaching/detaching the execution loop to an existing instance
- `/fsmpromise` → Actor/promise worker control: same pattern as fsmworker but for promise queues

These are genuinely different concerns. An FSM instance can exist without a worker running. The worker is the execution engine, not the instance itself.

**2. Consistent pattern**
`/fsmpromise` is already separate. Merging `fsmworker` into `fsm` would break the symmetry and leave `fsmpromise` as an odd-one-out.

**3. Extensibility**
Worker-specific operations (pause, resume, worker health, queue depth) belong naturally in `/fsmworker`, not `/fsm`. Keeping the route separate allows this without polluting the instance lifecycle API.

**4. Merging creates ambiguity**
If merged, `POST /fsm` would need to handle two cases:
- Create new instance (current behavior)
- Attach worker to existing instance

Distinguishing these by body shape is fragile; distinct routes are clearer.

---

## Design Issues to Fix (Deferred)

These are problems in the current architecture that should be addressed in a future refactor — they are **not** implemented in this session.

### Issue 1: `GET /fsm` returns the wrong data

`GET /fsm` currently returns `activeFSMLocks`. It should return a list of FSM instances from the database. `activeFSMLocks` (the in-memory map of running workers) belongs exclusively on `GET /fsmworker`.

**Fix (future):**
- `GET /fsm` → query `fsm_instance` table and return rows
- `GET /fsmworker` → return `activeFSMLocks` (already correct)

### Issue 2: `activeFSMLocks` is owned by the wrong module

`activeFSMLocks` is defined in `fsm.handlers.ts` and imported by `fsmworker.handlers.ts`. This creates a dependency from worker to instance handler, which is backwards — the worker owns lock state, not the instance.

**Fix (future):** Move `activeFSMLocks` to a shared module (e.g., `lib/worker-state.ts`) and import it in both `fsm.handlers.ts` and `fsmworker.handlers.ts`. This eliminates the circular-feeling import.

```
lib/
  worker-state.ts   # export const activeFSMLocks: Record<string, boolean> = {}
routes/
  fsm/
    fsm.handlers.ts    # import { activeFSMLocks } from "../../lib/worker-state.ts"
  fsmworker/
    fsmworker.handlers.ts  # import { activeFSMLocks } from "../../lib/worker-state.ts"
```

---

## Summary

| Criterion | Keep Separate | Merge into /fsm |
|---|---|---|
| Separation of concerns | ✅ Clear boundary | ❌ Mixed |
| API clarity for clients | ✅ Distinct intent | ❌ Overloaded |
| Consistency with /fsmpromise | ✅ Same pattern | ❌ Inconsistent |
| Current implementation effort | ✅ Low (bug fixes only) | ❌ High (refactor) |

**Decision: Keep separate. Fix the data bugs (`GET /fsm` wrong return, `activeFSMLocks` ownership) in a future session.**
