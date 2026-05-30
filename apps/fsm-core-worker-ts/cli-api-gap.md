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

---

## Gap 1 — `start-worker` has no dedicated HTTP route (deferred)

`POST /fsmworker` always calls `startFSMWorkerWithDBLock`. No route for the bare `startFSMWorker` (no lock). Out of scope — the lock variant covers all production cases.

---

## Gap 2 — `createAndStartFSMWorker` covered by `POST /fsm` (no dedicated route needed)

`POST /fsmworker/create-and-start` does **not** exist. `createAndStartFSMWorker` is called directly by the `POST /fsm` create handler (`routes/fsm/fsm.handlers.ts:53`):

```ts
const fsm_instance = await createAndStartFSMWorker(
  deps, input_fsm_name, input_fsm_version, matchedModule ?? {}, activeFSMLocks, input_fsm_context,
);
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
- `apps/fsm-core-ts-hono-deno/routes/fsm/fsm.handlers.ts:57`
- `apps/fsm-core-ts-hono-deno/routes/fsm/fsm.handlers.ts` (start handler, formerly fsmworker.handlers.ts:75)

`c.get("verifiedModules")` always returns `undefined` at runtime. The middleware sets `"verifiedFsmModules"` (see `lib/types.ts` — `ContextVariableMap`).

**Fix:** `c.get("verifiedModules")` → `c.get("verifiedFsmModules")` in both files.

---

## Gap 6 — `fsm.handlers.ts` passes `false` as `fsm_context` ✅ Fixed

**File:** `apps/fsm-core-ts-hono-deno/routes/fsm/fsm.handlers.ts:68`

```ts
// Before (type error — false is boolean, not Json)
createAndStartFSMWorker(deps, input_fsm_name, input_fsm_version, matchedModule, activeFSMLocks, false)

// After
createAndStartFSMWorker(deps, input_fsm_name, input_fsm_version, matchedModule ?? {}, activeFSMLocks, {})
```

Also fixes `matchedModule` being passed without `?? {}` fallback (parameter is non-optional but `find` may return `undefined`).

---

## Gap 7 — `fsmworker.handlers.ts` misuses `isFSMInstancePresent` return value ✅ Fixed

**File:** `apps/fsm-core-ts-hono-deno/routes/fsmworker/fsmworker.handlers.ts:57–83`

`isFSMInstancePresent` returns `boolean`. The handler then accesses `.fsm_name` and `.fsm_version` on it — always `undefined`. This causes `startFSMWorkerWithDBLock` to receive `undefined` for both name and version.

**Fix:** Replace `isFSMInstancePresent` with `getFsmDataResolveStateValue` which returns the full instance row (including `fsm_name` and `fsm_version`).

---

## Gap 8 — `fsmpromise.handlers.ts` imports non-existent `SendRoute` ✅ Fixed

**File:** `apps/fsm-core-ts-hono-deno/routes/fsmpromise/fsmpromise.handlers.ts:11`

```ts
// Before (type error — SendRoute not exported from fsmpromise.routes.ts)
import type { CreateRoute, ListRoute, SendRoute } from "./fsmpromise.routes.ts";

// After
import type { CreateAndStartRoute, CreateRoute, ListRoute } from "./fsmpromise.routes.ts";
```

---

## Gap 9 — Worker CLI `buildDeps()` has no `--db-url` flag (open)

**File:** `src/cli/index.ts:82–86`

```ts
async function buildDeps() {
  dotenv.config({ path: ".env" });
  const { Pool } = await import("pg");
  return { db: new Pool({ connectionString: Deno.env.get("DATABASE_URL") }), useSupabase: false };
}
```

The compiler CLI (`packages/fsm-compiler-ts`) added a `--db-url` / `-d` flag that takes precedence over `DATABASE_URL`. The worker CLI only reads `DATABASE_URL` — there is no flag to supply the connection string inline. Low priority, but inconsistent with the compiler CLI pattern.

**Fix:** Add `string: ["db-url"]` to `parseArgs`, alias `-d`, and pass it to `buildDeps()`:
```ts
return { db: new Pool({ connectionString: args["db-url"] ?? Deno.env.get("DATABASE_URL") }) };
```

---

## Gap 10 — Worker CLI does not validate `--fsm-folder-path` exists (open)

**File:** `src/cli/index.ts`

The CLI parses `--fsm-folder-path` (`-f`) and passes it directly to `verifiedModule` without checking that the path exists on disk. If the path is wrong, the error surfaces deep inside the module-loading logic with a cryptic message.

The compiler CLI validates `--folder` with `Deno.stat()` before proceeding. The worker CLI should do the same.

**Fix:** After the missing-args check, add:
```ts
try { await Deno.stat(fsmFolderPath!); } catch {
  console.error(`Error: --fsm-folder-path "${fsmFolderPath}" does not exist.`);
  Deno.exit(1);
}
```

---

## Summary

| Gap | Priority | Status |
|---|---|---|
| Gap 1: `start-worker` no dedicated route | Low | Deferred |
| Gap 2: `createAndStartFSMWorker` via `POST /fsm` | High | ✅ Implemented |
| Gap 3: `POST /fsmpromise/create-and-start` | High | ✅ Fixed |
| Gap 4: `POST /fsmpromise` arg mapping | High | ✅ Fixed |
| Gap 5: `verifiedModules` → `verifiedFsmModules` | Critical | ✅ Fixed |
| Gap 6: `false` as `fsm_context` | High | ✅ Fixed |
| Gap 7: `isFSMInstancePresent` misuse | Critical | ✅ Fixed |
| Gap 8: stale `SendRoute` import | Medium | ✅ Fixed |
| Gap 9: no `--db-url` flag in worker CLI | Low | Open |
| Gap 10: no `--fsm-folder-path` existence check | Low | Open |
