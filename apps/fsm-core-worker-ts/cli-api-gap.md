# CLI ↔ API Gap Analysis — fsm-core-worker-ts

This document maps the 5 CLI commands in `src/cli/index.ts` against the HTTP routes in `apps/fsm-core-ts-hono-deno/routes/` and records all gaps and bugs found.

---

## Coverage matrix

| CLI command | Underlying TS function | HTTP route | Status |
|---|---|---|---|
| `start-worker` | `startFSMWorker` | None dedicated | Low priority — deferred |
| `start-worker-with-db-lock` | `startFSMWorkerWithDBLock` | `POST /fsm/start` | ✅ Implemented (bugs fixed — see Gap 5, 7) |
| `start-promise-worker` | `startFSMPromiseWorker` | `POST /fsmpromise` | ✅ Implemented (bugs fixed — see Gap 4, 8) |
| `create-and-start-worker` | `createAndStartFSMWorker` | `POST /fsm` (create handler) | ✅ Implemented via POST /fsm |
| `create-and-start-promise-worker` | `createAndStartPromiseWorker` | `POST /fsmpromise/create-and-start` | ✅ Implemented |

> **Note:** `/fsmworker` routes were merged into `/fsm` in commit `2d6f83a`. The HTTP equivalents above reflect the current route paths.

---

## Gap 1 — `start-worker` has no dedicated HTTP route (deferred)

`POST /fsm/start` always calls `startFSMWorkerWithDBLock`. No route for the bare `startFSMWorker` (no lock). Out of scope — the lock variant covers all production cases.

---

## Gap 2 — `createAndStartFSMWorker` covered by `POST /fsm` (no dedicated route needed)

`createAndStartFSMWorker` is called directly by the `POST /fsm` create handler (`routes/fsm/fsm.handlers.ts`):

```ts
const controller = new AbortController();
let instanceId: string | null = null;

const fsm_instance = await createAndStartFSMWorker(
  deps,
  input_fsm_name,
  input_fsm_version,
  matchedModule ?? {},
  input_fsm_context,
  undefined,
  controller.signal,
  () => { if (instanceId) delete activeWorkers[instanceId]; },
);

if (fsm_instance) {
  instanceId = fsm_instance.fsm_instance_id;
  activeWorkers[instanceId] = { lock: true, controller };
}
```

**Route:** `POST /fsm`
**Body:** `{ fsm_name: string, fsm_version: string, fsm_context?: object }`
**Response:** `{ data: { fsm_instance_id, fsm_version, ... } }`

`verifiedModule` looked up by `fsm_name` + `fsm_version` from `c.get("verifiedFsmModules")`.

---

## Gap 3 — `POST /fsmpromise/create-and-start` ✅ Implemented

Creates a PGMQ queue and starts a promise (actor) worker.

**Route:** `POST /fsmpromise/create-and-start`
**Body:** `{ queue_name: string, fsm_name: string, promise_type: string, fsm_version: string }`
**Response:** `{}`

`verifiedModule` looked up by `fsm_name` + `fsm_version` from `c.get("verifiedFsmModules")`.

---

## Gap 4 — `POST /fsmpromise` broken arg mapping ✅ Fixed

**File:** `apps/fsm-core-ts-hono-deno/routes/fsmpromise/fsmpromise.handlers.ts`

**Before (broken):**
```ts
startFSMPromiseWorker(deps, promise_name, promise_name, input_promise_version)
// ^ passes version where type is expected; missing version and verifiedModule
```

**After (fixed):** Body extended with `promise_type`, `fsm_name`, `fsm_version`. Handler now calls:
```ts
startFSMPromiseWorker(deps, promise_name, promise_name, promise_type, promise_version, matchedModule)
```

---

## Gap 5 — Wrong Hono context key (`verifiedModules` → `verifiedFsmModules`) ✅ Fixed

**Affected files:**
- `apps/fsm-core-ts-hono-deno/routes/fsm/fsm.handlers.ts` (create handler)
- `apps/fsm-core-ts-hono-deno/routes/fsm/fsm.handlers.ts` (start handler)

`c.get("verifiedModules")` always returns `undefined` at runtime. The middleware sets `"verifiedFsmModules"` (see `lib/types.ts` — `ContextVariableMap`).

**Fix:** `c.get("verifiedModules")` → `c.get("verifiedFsmModules")` in both files.

---

## Gap 6 — `fsm.handlers.ts` passes `false` as `fsm_context` ✅ Fixed

**File:** `apps/fsm-core-ts-hono-deno/routes/fsm/fsm.handlers.ts`

```ts
// Before (type error — false is boolean, not Json)
createAndStartFSMWorker(deps, input_fsm_name, input_fsm_version, matchedModule, activeFSMLocks, false)

// After
createAndStartFSMWorker(deps, input_fsm_name, input_fsm_version, matchedModule ?? {}, {})
```

Also fixes `matchedModule` being passed without `?? {}` fallback (parameter is non-optional but `find` may return `undefined`).

---

## Gap 7 — `fsmworker.handlers.ts` misuses `isFSMInstancePresent` return value ✅ Fixed

**File:** (formerly `fsmworker.handlers.ts`, now merged into `fsm.handlers.ts` — start handler)

`isFSMInstancePresent` returns `boolean`. The handler was accessing `.fsm_name` and `.fsm_version` on it — always `undefined`. This caused `startFSMWorkerWithDBLock` to receive `undefined` for both name and version.

**Fix:** Replace `isFSMInstancePresent` with `getFsmDataResolveStateValue` which returns the full instance row (including `fsm_name` and `fsm_version`).

---

## Gap 8 — `fsmpromise.handlers.ts` imports non-existent `SendRoute` ✅ Fixed

**File:** `apps/fsm-core-ts-hono-deno/routes/fsmpromise/fsmpromise.handlers.ts`

```ts
// Before (type error — SendRoute not exported from fsmpromise.routes.ts)
import type { CreateRoute, ListRoute, SendRoute } from "./fsmpromise.routes.ts";

// After
import type { CreateAndStartRoute, CreateRoute, ListRoute } from "./fsmpromise.routes.ts";
```

---

## Gap 9 — Worker CLI `buildDeps()` has no `--db-url` flag ✅ Fixed

**File:** `src/cli/index.ts`

The compiler CLI (`packages/fsm-compiler-ts`) added a `--db-url` / `-d` flag that takes precedence over `DATABASE_URL`. The worker CLI previously only read `DATABASE_URL`.

**Fix applied:**
```ts
string: [..., "db-url"],
alias: { ..., d: "db-url" },
// in buildDeps:
connectionString: dbUrl ?? Deno.env.get("DATABASE_URL")
```

---

## Gap 10 — Worker CLI does not validate `--fsm-folder-path` exists ✅ Fixed

**File:** `src/cli/index.ts`

The CLI parsed `--fsm-folder-path` (`-f`) and passed it directly to `verifiedModule` without checking that the path exists on disk.

**Fix applied:** After the missing-args check:
```ts
try { await Deno.stat(fsmFolderPath!); } catch {
  console.error(`Error: --fsm-folder-path "${fsmFolderPath}" does not exist.`);
  Deno.exit(1);
}
```

---

## Gap 11 — CLI has no SIGINT/SIGTERM handlers ✅ Fixed

**File:** `src/cli/index.ts`

The CLI used `await new Promise(() => {})` as an infinite block but registered no signal listeners. Pressing Ctrl+C (SIGINT) killed the process immediately — the worker loop could not finish its current iteration, and the DB advisory lock was not explicitly released (relied on session-end cleanup from the pg driver).

**Fix applied:** Register Deno signal listeners that trigger an `AbortController`. The signal is passed to all worker start functions (which already support `AbortSignal` internally via `while (!signal?.aborted)`). Fire-and-forget commands block on `waitForAbort()` (a promise that resolves when the signal fires) instead of the infinite promise. Second Ctrl+C calls `Deno.exit(0)` immediately.

```ts
const controller = new AbortController();
let shutdownRequested = false;

const onSignal = () => {
  if (shutdownRequested) { Deno.exit(0); }
  shutdownRequested = true;
  console.log("\nShutdown requested — stopping worker gracefully. Ctrl+C again to force exit...");
  controller.abort();
};

Deno.addSignalListener("SIGINT", onSignal);
Deno.addSignalListener("SIGTERM", onSignal);
```

---

## Summary

| Gap | Priority | Status |
|---|---|---|
| Gap 1: `start-worker` no dedicated route | Low | Deferred |
| Gap 2: `createAndStartFSMWorker` via `POST /fsm` | High | ✅ Fixed |
| Gap 3: `POST /fsmpromise/create-and-start` | High | ✅ Fixed |
| Gap 4: `POST /fsmpromise` arg mapping | High | ✅ Fixed |
| Gap 5: `verifiedModules` → `verifiedFsmModules` | Critical | ✅ Fixed |
| Gap 6: `false` as `fsm_context` | High | ✅ Fixed |
| Gap 7: `isFSMInstancePresent` misuse | Critical | ✅ Fixed |
| Gap 8: stale `SendRoute` import | Medium | ✅ Fixed |
| Gap 9: no `--db-url` flag in worker CLI | Low | ✅ Fixed |
| Gap 10: no `--fsm-folder-path` existence check | Low | ✅ Fixed |
| Gap 11: no SIGINT/SIGTERM signal handlers in CLI | Medium | ✅ Fixed |
