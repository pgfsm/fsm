# Goal: `fsm-core-async-op-worker`

Not committed. Scoping notes only — no code changes made against this document.

`fsm-core-async-op-worker` is a standalone **alternative** to
`fsm-async-worker-ts` — not something that integrates with or is invoked by it.
It owns its own poll/dispatch/archive loop end to end; nothing in this document
depends on `fsm-async-worker-ts`'s existing implementation.

**Status: all 8 target-behavior steps below are now implemented** (see the
comparison table in §3) — this doc is kept as the scoping/design record, not
because gaps remain against the original ask. Real remaining gaps (not part of
the original 8 steps) are listed at the end of §3.

## 1. Target behavior

1. **Listen for `register` events, add to a workers list.** Worker processes
   (TS/Python/Rust/Go) connect over the sidecar Unix socket and announce the
   actors they serve; the gateway adds each to an in-memory workers list.

2. **Worker definition shape** (per registered actor):

   ```ts
   {
     parentFsmName: "creditCheck",
     parentFsmVersion: "v01",
     asyncOperationType: "internalAsyncOperation",
     asyncOperationName: "checkReportsTable",
     asyncOperationVersion: "v01",
     asyncOperationLanguage: "typescript",
     handler: checkReportsTable,
   }
   ```

3. **Every 30 seconds, call a Postgres function** (new, dummy for now) with the
   workers array — minus `handler`, which isn't serializable — as input. Example
   shape sent:

   ```ts
   [
     {
       parentFsmName: "creditCheck",
       parentFsmVersion: "v01",
       asyncOperationType: "internalAsyncOperation",
       asyncOperationName: "checkReportsTable",
       asyncOperationVersion: "v01",
       asyncOperationLanguage: "typescript",
     },
     // ...
   ];
   ```

4. **New Postgres function** lives in `database-src`; a matching TS wrapper
   lives in `fsm-core-db-ts`. The TS wrapper is what gets called on the
   30-second interval from (3).

5. **For each object in the Postgres function's response**, call the
   corresponding language's gRPC/IPC invoke path (dispatch to the registered
   worker for that actor identity).

6. **For each IPC response**, call
   `archiveEventFromFsmAsyncOperationTypeWorker`.

7. **Non-blocking, repeating loop**: the 30-second cycle (3)→(4)→(5)→(6) doesn't
   block on any single actor's dispatch, and restarts every 30 seconds
   regardless of how long the previous cycle's dispatches took.

8. **Optionally** expose `listRegisteredActors` (already does, see below).

## 2. Current implementation — function inventory

Scanned `packages/fsm-core-async-op-worker/src/` directly (all exported
symbols):

| File                                        | Export                                           | What it does                                                                                                                                                                                                                                                        |
| ------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar/gateway.ts`                        | `actorKey()`                                     | Builds the `parentFsmName@...@asyncOperationLanguage` routing key from an identity tuple.                                                                                                                                                                           |
| `sidecar/gateway.ts`                        | `class SidecarGateway`                           | Owns the worker-facing Unix socket.                                                                                                                                                                                                                                 |
| `sidecar/gateway.ts`                        | `SidecarGateway.start()` / `.stop()`             | Opens/closes the Unix listener.                                                                                                                                                                                                                                     |
| `sidecar/gateway.ts`                        | `SidecarGateway.registerWorker()` _(private)_    | Handles an incoming `register` wire message — adds the worker connection to an in-memory `Map`, keyed by actorKey, and fires `onActorRegistered` (if configured) per actor. Also now logs each `invoke_result`/`invoke_error` response as it arrives from a worker. |
| `sidecar/gateway.ts`                        | `SidecarGateway.unregisterWorker()` _(private)_  | Removes a worker on `unregister`/disconnect.                                                                                                                                                                                                                        |
| `sidecar/gateway.ts`                        | `SidecarGateway.invoke()`                        | Sends an `invoke` wire message to whichever worker owns the target actorKey, awaits `invoke_result`/`invoke_error`.                                                                                                                                                 |
| `sidecar/gateway.ts`                        | `SidecarGateway.listRegisteredActors()`          | Returns the currently-registered actor keys.                                                                                                                                                                                                                        |
| `sidecar/gateway.ts`                        | `SidecarGateway.listRegisteredActorIdentities()` | **New.** Returns full `RegisteredActor[]` (not just keys) — what the poll loop sends to `claimPendingAsyncOperationEventsForWorkers`.                                                                                                                               |
| `sidecar/gateway.ts`                        | `SidecarGatewayOptions.onActorRegistered`        | **New.** Optional callback fired per actor on registration — what `gatewayServer.ts` hooks `ensureQueueOnRegister` into.                                                                                                                                            |
| `asyncOpPollLoop.ts`                        | `startAsyncOpPollLoop()`                         | **New.** The 30s (default) poll loop — implements steps 3–7 in full (see §3).                                                                                                                                                                                       |
| `asyncOpPollLoop.ts`                        | `dispatchAndArchive()`                           | **New.** One claimed event → `sidecar.invoke()` → `archiveEventFromFsmAsyncOperationTypeWorker()`, never throws.                                                                                                                                                    |
| `asyncOpPollLoop.ts`                        | `parseClaimedAsyncOperationEvent()`              | **New.** Validates/narrows a raw claimed jsonb row into `ClaimedAsyncOperationEvent`.                                                                                                                                                                               |
| `gatewayServer.ts`                          | `startActivityGatewayServer()`                   | Starts the client-facing Connect/gRPC server (`Invoke`, `ListRegisteredActors`), backed by a `SidecarGateway`. Now also optionally starts the poll loop and/or wires `ensureQueueOnRegister`, sharing the same `SidecarGateway` instance.                           |
| `gatewayServer.ts`                          | `GatewayServerOptions.asyncOpPollLoop`           | **New.** `{ deps, intervalMs?, invokeTimeoutMs? }` — opt-in poll loop, on by default via the CLI.                                                                                                                                                                   |
| `gatewayServer.ts`                          | `GatewayServerOptions.ensureQueueOnRegister`     | **New.** `{ deps }` — opt-in PGMQ queue-ensure on every actor registration.                                                                                                                                                                                         |
| `gatewayClient.ts`                          | `class ActivityGatewayClient`                    | Connect/gRPC client for the above — `invokeActor()`, `listRegisteredActors()`, `close()`.                                                                                                                                                                           |
| `gatewayClient.ts`                          | `class ActivityGatewayInvokeError`               | Typed error for a failed `invoke` (code + retriable flag).                                                                                                                                                                                                          |
| `cli/async-operation-worker-gateway.ts`     | (entry point)                                    | `deno task gateway` — starts the gateway process. Now takes `-d/--db-url`, `--poll-interval-ms`, `--disable-poll-loop`, `--ensure-queue-on-register` (see `docs/guides/CLI-USAGE.md`).                                                                              |
| `cli/async-operation-worker-gateway-ctl.ts` | (entry point)                                    | `deno task gateway-ctl <list\|invoke>` — debug/test client.                                                                                                                                                                                                         |
| `index.ts`                                  | re-exports                                       | Public package surface: the above minus internals.                                                                                                                                                                                                                  |

Shared DB-layer primitives this package's poll loop/queue-ensure build on
(`fsm-core-db-ts` / `database-src` — not `fsm-async-worker-ts`, plain reusable
helpers, callable from anywhere):

| Package          | Symbol                                                           | What it does                                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fsm-core-db-ts` | `archiveEventFromFsmAsyncOperationTypeWorker()`                  | Pre-existing. TS wrapper around a real Postgres archive function — reusable, not tied to any particular caller.                                                                                 |
| `fsm-core-db-ts` | `claimPendingAsyncOperationEventsForWorkers()`                   | **New, implemented for real** (not a stub). Returns pending PGMQ work for a batch of worker identities.                                                                                         |
| `fsm-core-db-ts` | `ensureAsyncOperationQueueForWorker()`                           | **New.** Idempotently ensures a PGMQ queue exists for one worker identity.                                                                                                                      |
| `database-src`   | `archive_event_from_fsm_async_operation_type_worker_v2` (SQL fn) | Pre-existing, backs the TS wrapper above.                                                                                                                                                       |
| `database-src`   | `claim_pending_async_operation_events_for_workers_v2` (SQL fn)   | **New, implemented for real.** Iterates worker identities, computes each queue name, reads up to one message per existing queue. See `docs/guides/CLI-USAGE.md`'s "PGMQ message payload shape". |
| `database-src`   | `ensure_async_operation_queue_for_worker_v2` (SQL fn)            | **New.** Idempotent queue-ensure, called on worker registration when `--ensure-queue-on-register` is set.                                                                                       |
| `database-src`   | `compute_async_operation_queue_name_v2` (SQL fn)                 | **New.** Shared queue-naming logic factored out of the two functions above so they can't drift.                                                                                                 |

## 3. Comparison table

| # | Goal step                                                                            | Current implementation                                                                                                                                                                                                                                                                                                                                                                                  | Status                                           |
| - | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1 | Listen for `register`, add to workers list                                           | `SidecarGateway.registerWorker()`.                                                                                                                                                                                                                                                                                                                                                                      | ✅ Have                                          |
| 2 | Worker def shape incl. `handler`                                                     | Resolved, not just "different shape": dispatch never needs an in-process `handler` at all — it always goes through `sidecar.invoke()` over the socket, even for TypeScript workers. Registered-worker state (`RegisteredActor`, exposed via `listRegisteredActorIdentities()`) is exactly the goal's shape _minus_ `handler`, which the goal itself says gets stripped before the Postgres call anyway. | ✅ Have (by design — `handler` was never needed) |
| 3 | Every 30s, call (new) Postgres fn with workers array (no `handler`)                  | `startAsyncOpPollLoop()` — default 30s (`--poll-interval-ms`), calls `claimPendingAsyncOperationEventsForWorkers(deps, sidecar.listRegisteredActorIdentities())`.                                                                                                                                                                                                                                       | ✅ Have                                          |
| 4 | New Postgres fn (database-src) + TS wrapper (fsm-core-db-ts), called on the 30s tick | `claim_pending_async_operation_events_for_workers_v2` + `claimPendingAsyncOperationEventsForWorkers()` — implemented for real (queue-name-per-worker, `pgmq.read`), not a stub.                                                                                                                                                                                                                         | ✅ Have                                          |
| 5 | For each response object, call its lang gRPC/IPC fn                                  | `dispatchAndArchive()` calls `sidecar.invoke()` per claimed row.                                                                                                                                                                                                                                                                                                                                        | ✅ Have                                          |
| 6 | Call `archiveEventFromFsmAsyncOperationTypeWorker` from the IPC response             | `dispatchAndArchive()` calls it after every dispatch, success or failure.                                                                                                                                                                                                                                                                                                                               | ✅ Have                                          |
| 7 | Non-blocking, repeats every 30s                                                      | Each claimed row's `dispatchAndArchive()` is fire-and-forget (never awaited by the tick), and the tick loop reschedules itself on a fixed interval regardless of dispatch duration.                                                                                                                                                                                                                     | ✅ Have                                          |
| 8 | `listRegisteredActors` exposed                                                       | `SidecarGateway.listRegisteredActors()` and the client-facing `ListRegisteredActors` RPC / `gateway-ctl list`.                                                                                                                                                                                                                                                                                          | ✅ Have                                          |

### What current implementation has _beyond_ this goal

- The **client-facing gRPC/Connect server** (`gatewayServer.ts` / `Invoke` RPC)
  — a whole boundary this goal doesn't mention, used by whatever calls
  `ActivityGatewayClient` directly.
- **Sidecar wire protocol** (the generated `SidecarGatewayService` gRPC stream,
  #100) — plumbing this goal takes for granted rather than states as a
  requirement.
- **`ActivityGatewayInvokeError`** (typed, code + retriable) — richer error
  shape than "call archive with the response," which this goal doesn't specify
  error handling for.
- **Debug CLI** (`async-operation-worker-gateway-ctl.ts`) for manual
  `list`/`invoke` testing.
- **`--ensure-queue-on-register`** — not part of the original 8 steps at all:
  optionally ensures a PGMQ queue exists for every actor a worker registers, so
  the poll loop has something to read from without a separate provisioning step.
- **Worker-response logging** — every `invoke_result`/`invoke_error` a worker
  sends back is now logged as it arrives, not just silently resolved against the
  pending promise.

### Real remaining gaps (not part of the original 8 steps)

- ~~No outcome-dependent `eventName` prefixing.~~ **Fixed.**
  `claim_pending_async_operation_events_for_workers_v2` still runs before
  `sidecar.invoke()`, so `eventName` in the claimed row is still the raw
  `sendToParentQueueIdEventName` from the PGMQ message — but
  `dispatchAndArchive()` now prefixes it with `"xstate.done.actor."` /
  `"xstate.error.actor."` (based on the invoke outcome) before archiving,
  matching `fsm-async-worker-ts`'s working convention
  (`fsmasyncoperationworker-helper.ts`'s `send_event_name_to_parent_queue_id`).
  Without this the fsmlet could never find a matching transition for the raw
  eventName and the FSM instance stayed stuck at the invoking state forever,
  even though the actor invoke itself succeeded — caught via a real end-to-end
  run, not just unit coverage.
- **PGMQ's 48-character queue name limit** isn't fully solved. The
  `async_operation_type = "internalAsyncOperation"` shortening (drop
  `async_operation_version`, first-char `async_operation_language`) fits typical
  identities, but the non-`"internalAsyncOperation"` path
  (`sharedAsyncOperation` etc.) still carries the full identity and remains
  exposed; very long `parentFsmName`/`asyncOperationName` values can exceed it
  either way. The queue-ensure and claim-read calls both just throw/skip in that
  case today — no truncation/hashing fallback.
- **No automated test coverage.** Everything in §3 above was verified manually
  this session (real local DB, real Unix socket connections, real enqueued PGMQ
  messages) — there's no `deno test` suite covering `asyncOpPollLoop.ts`, the
  new `SidecarGateway` methods, or the new SQL functions.
- **`asyncOpPollLoop`/`ensureQueueOnRegister` are opt-in via
  `GatewayServerOptions`,** not automatically active just because
  `SidecarGateway` exists — a caller constructing
  `SidecarGateway`/`startActivityGatewayServer` directly (bypassing the CLI)
  gets none of this unless they pass the options explicitly.
