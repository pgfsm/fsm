# API ↔ @fsm/worker Integration Gaps

This document records all bugs and gaps found between `apps/fsm-core-ts-hono-deno` and the `@fsm/worker` package (`apps/fsm-core-worker-ts`).

---

## Bug table

| # | Severity | File | Line | Description | Fix |
|---|---|---|---|---|---|
| 1 | Critical | `routes/fsm/fsm.handlers.ts` | 57 | `c.get("verifiedModules")` — key does not exist in `ContextVariableMap`. Middleware sets `"verifiedFsmModules"`. Always returns `undefined` at runtime. | `c.get("verifiedFsmModules")` |
| 2 | Critical | `routes/fsmworker/fsmworker.handlers.ts` | 75 | Same wrong context key | `c.get("verifiedFsmModules")` |
| 3 | High | `routes/fsm/fsm.handlers.ts` | 68 | `false` (boolean) passed as `fsm_context: Json` to `createAndStartFSMWorker`. 6th positional arg expects `Json`. | Pass `{}` |
| 4 | High | `routes/fsm/fsm.handlers.ts` | 66 | `matchedModule` from `find()` may be `undefined`, but `createAndStartFSMWorker` parameter is non-optional `VerifiedModule`. | `matchedModule ?? {}` |
| 5 | Critical | `routes/fsmworker/fsmworker.handlers.ts` | 57–83 | `isFSMInstancePresent` returns `boolean`. Handler accesses `.fsm_name` and `.fsm_version` on it — both are `undefined`. `startFSMWorkerWithDBLock` receives `undefined` for name and version. | Replace with `getFsmDataResolveStateValue` which returns full instance row |
| 6 | Medium | `routes/fsmpromise/fsmpromise.handlers.ts` | 11 | Imports `SendRoute` type which is not exported from `fsmpromise.routes.ts`. TypeScript error. | Remove import |
| 7 | High | `routes/fsmpromise/fsmpromise.handlers.ts` | 59–64 | `startFSMPromiseWorker` called with wrong args: `input_promise_version` passed as `fsm_promise_type` (3rd positional); `fsm_promise_version` and `verifiedModule` missing entirely. | Fix body schema; add `promise_type`, `fsm_name`, `fsm_version` fields; look up `verifiedFsmModules` |
| 8 | High | `routes/fsmworker/fsmworker.routes.ts` | — | `POST /fsmworker/create-and-start` route was removed | Re-add route + type export |
| 9 | High | `routes/fsmpromise/fsmpromise.routes.ts` | — | `POST /fsmpromise/create-and-start` route was removed | Re-add route + type export |

---

## @fsm/worker exports usage

### Used by API server

| Export | Import site |
|---|---|
| `createAndStartFSMWorker` | `routes/fsm/fsm.handlers.ts` |
| `startFSMWorkerWithDBLock` | `routes/fsmworker/fsmworker.handlers.ts` |
| `createAndStartFSMWorker` | `routes/fsmworker/fsmworker.handlers.ts` (createAndStart handler) |
| `startFSMPromiseWorker` | `routes/fsmpromise/fsmpromise.handlers.ts` |
| `createAndStartPromiseWorker` | `routes/fsmpromise/fsmpromise.handlers.ts` (createAndStart handler) |
| `createAndStartPromiseWorker` | `lib/create-app.ts` (startup internal actors) |

### Not used by API server (internal to worker loop)

| Export | Purpose |
|---|---|
| `startFSMWorker` | Base polling loop — called internally by `startFSMWorkerWithDBLock` |
| `macrostepV2` | Core FSM step — used internally by `startFSMWorker` |
| `runActionImplementation` | Action executor — used internally by `macrostepV2` |
| `splitByEventTypes` | Queue helper — used internally |
| `splitBySendEventName` | Queue helper — used internally |
| `processFSMPromiseQueueMessage` | Promise message processor — used internally by `startFSMPromiseWorker` |
| `FsmQueueMessage` / `FsmQueueMessageEventData` | Internal queue message types |
| `FsmModuleDefinition` | Internal module definition type |
| `FSMPromiseArchiveData` | Internal archive data type |

These are legitimately exported for consumers who want to build their own worker loops, but the API server does not need them directly.

---

## Context variable key reference

The `ContextVariableMap` in `lib/types.ts` defines these Hono context variables:

| Key | Type | Set by |
|---|---|---|
| `db` | `any` (pg Pool) | `create-app.ts` middleware |
| `supabase` | `SupabaseClient` | Supabase middleware |
| `logger` | `PinoLogger` | Pino middleware |
| `fsmConfig` | `FsmStartupConfig` | `create-app.ts` |
| `verifiedFsmModules` | `{ fsmName, fsmVersion, fsmType, fsmAbsFolderPath, ... }[]` | `create-app.ts` middleware |

**Note:** `"verifiedModules"` is NOT a valid key and will always return `undefined` at runtime.

---

## How `verifiedFsmModules` is populated

In `lib/create-app.ts`:
1. FSM modules are loaded from three configured folder sources (sharedPromise, sharedFsm, fsm)
2. Each is filtered to `isFsmModuleVerified === true`
3. Combined array is set via `c.set("verifiedFsmModules", verifiedFsmModules)` in every request middleware

**Lookup pattern (correct):**
```ts
const verifiedModules = c.get("verifiedFsmModules");
const matchedModule = verifiedModules?.find(
  (m: any) => m.fsmName === fsm_name && m.fsmVersion === fsm_version,
);
```
