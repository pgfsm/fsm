# SPEC-012: Cancel an In-Flight Actor Invoke in Its Worker

| Field   | Value                                                                                                                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status  | Implemented                                                                                                                                                                                                                                                              |
| Date    | 2026-10-20                                                                                                                                                                                                                                                               |
| Authors | Niraj, Claude (Opus 5.5)                                                                                                                                                                                                                                                 |
| Issue   | #514                                                                                                                                                                                                                                                                     |
| Affects | `packages/fsm-async-worker-gateway-ts`, `packages/fsm-proto-codegen` (`sidecar_gateway.proto`), `packages/fsm-async-worker-sdk-{ts,python,rust,go}`, `packages/fsm-compiler-ts` (handler scaffolds), `packages/database-src` (sweep and ack-log functions), `test-apps/` |

Gateway and SDK half of #514. It **depends on
[SPEC-011](spec-011-stop-invokes-on-state-exit.md)**: the cancel notification
and the archive gate come from SPEC-011's `finish_async_operation_event_v2`, and
the sweep below relies on that gate.

Related: #512 (the cancel notification's fixed channel), #396 (retriable
failures are redelivered), SPEC-007 (gateway behind a transaction pooler,
connection drain).

---

## Problem

When a state exits, its actor's message is cancelled
(`finish_async_operation_event_v2('cancelled', …)` after SPEC-011): the message
is archived, and `fsm_async_operation_cancel` is notified with
`{"queue_name", "msg_id"}`. That only stops work that hasn't started. The
gateway claims messages with a visibility-timeout read, not a delete, so a
message that has been handed to a worker is still in its queue. The archive
succeeds, but nothing tells the worker, and the handler runs to completion, side
effects included. (SPEC-011 makes sure its late result never reaches the
parent.) Nothing listens to the notification, and `Cancel { invoke_id }` in
`sidecar_gateway.proto` is never sent; the SDKs accept it and ignore it.

The gateway has the same gap wherever it gives up on an invoke the worker is
still running:

- **Invoke timeout.** The gateway rejects the invoke as `TIMEOUT` (retriable),
  leaves the message for redelivery (#396), and the worker keeps running. Once
  the visibility timeout ends, another invoke of the same message can run
  alongside the first.
- **Shutdown.** `SidecarGateway.stop()` does not wait for in-flight invokes. It
  rejects them as `WORKER_DISCONNECTED` (retriable) and ends the streams. The
  handlers keep running, their results land on a dead stream, and the messages
  are redelivered.
- **Max-connection-age drain.** `scheduleMaxAge` waits up to
  `connectionDrainGraceMs`, then does the same as shutdown with whatever is
  still running.

Who is affected: any FSM whose actors have side effects (payments, emails,
external calls) and whose states can exit before the actor finishes. That
includes every `after` timeout racing an actor (#516), and any actor that can
time out or be caught by a gateway restart.

## Constraints

- **ADR-003: the gateway is the only DB-touching activity tier;** workers stay
  zero-DB. Cancellation must reach workers over the existing `Session` stream,
  not through Postgres.
- **SPEC-007: the gateway's pool sits behind PgBouncer in `transaction` mode**
  (`deploy/k8s/examples/pooler`). `LISTEN` does not work through transaction
  pooling: notifications on a pooled server connection never reach the client
  that asked for them. A listener needs its own direct or session-mode
  connection. SPEC-007 already budgets "gateway replicas × pool max (+ any
  LISTEN connections)".
- **NOTIFY is at most once.** A gateway that is down or reconnecting when the
  cancel commits never sees the notification.
- **No SDK can safely kill a running handler.** TS (a promise), Go (a
  goroutine), Rust (`spawn_blocking`) and Python (a thread) have no safe
  preemption, so cancellation is cooperative. A handler that ignores the
  cancellation still runs to completion.
- **Several gateway replicas.** Every replica receives every notification; only
  the one that dispatched the message may act on it.
- **Delivery stays at least once** (#396); actors must already be idempotent.
  This spec reduces duplicate and orphaned execution. It does not promise
  exactly once.

## Options considered

### 1. How the gateway learns a message was cancelled

**A. LISTEN/NOTIFY only** (as #514 sketches). Push, with sub-second latency. But
it needs a non-pooled connection, and a notification lost while the listener is
down is never retried. Behind the transaction pooler it silently does nothing.

**B. Sweep only.** Every few seconds the gateway asks Postgres which of its
in-flight `(queue_name, msg_id)` pairs are no longer in their queues. Works
through the pooler with no extra connection, and recovers anything it missed.
Latency equals the sweep interval, and it costs one batched query per interval
per gateway (only while something is in flight).

**C. Hybrid: LISTEN when configured, plus the sweep.** LISTEN gives low latency
where a direct connection exists. The sweep is the backstop for missed
notifications, and the only mechanism where no direct connection is configured.

### 2. What a `Cancel` does in the worker SDKs

**A. Cooperative, opt-in.** A new registration variant passes a cancellation
token; existing handlers keep compiling. Two handler shapes per SDK, and most
handlers never become cancellable.

**B. Cooperative, every handler.** Every handler signature takes the token. A
breaking change in all four SDKs, but one API, and every handler is at least
offered the signal.

**C. Discard only.** The SDK never interrupts the handler; it discards the
result and frees the slot early. Simplest, but side effects still run, which is
the thing this spec exists to stop.

### 3. When the concurrency slot frees after a `Cancel`

**A. When the worker replies.** Any reply to the cancelled invoke (a `CANCELLED`
error, or a late result) frees the slot. A handler that ignores the token keeps
counting against `max_concurrency`, which is honest backpressure.

**B. Immediately on `Cancel`.** Faster reuse, but it over-subscribes a worker
whose handler is still running.

For a handler that never replies, the alternatives were: hold the slot until the
reply or the session ends (and warn); force-disconnect the worker after a grace
period; or free the slot after a grace period.

### 4. Rolling out the breaking SDK change

**A. Major SDK bumps, gateway stays compatible.** Old SDKs ignore `Cancel` and
send their late result, which the gateway drops. No lockstep needed.

**B. Lockstep through `protocol_version`.** Bump the sidecar protocol to `2.0`;
the gateway rejects workers that register with `1.x`. Easier to reason about:
every connected worker is known to honour `Cancel`.

## Decision

**Detection: 1C (hybrid).** The gateway LISTENs on `fsm_async_operation_cancel`
when, and only when, it is given a direct connection URL, and it always runs the
sweep. Driver: correctness can't depend on an at-most-once channel or on a
deployment detail (whether a pooler is in front). LISTEN is only an optimisation
for latency. 1A loses because it is silently inert behind the SPEC-007 pooler.
1B on its own loses only on latency; it is what you get when no listener URL is
set.

**SDK model: 2B (cooperative, every handler).** Driver: an actor author should
not have to know cancellation exists to get the signal, and one handler shape
per SDK is simpler to document, scaffold, and test than two. 2A loses because
cancellable would stay the exception. 2C loses because side effects still run.

**Triggers:** a `Cancel` is sent when

1. the message's state exits (detected by LISTEN or the sweep), reason
   `STATE_EXITED`;
2. the gateway's invoke timeout fires, reason `TIMEOUT`;
3. `stop()` runs, or a max-age drain reaches its deadline with invokes still
   running, reason `SHUTDOWN`.

Shutdown keeps today's timing: `stop()` does not start waiting for in-flight
invokes. Making shutdown drain first is a separate change, if wanted.

**Slot release: 3A (on the worker's reply).** If the worker never replies, the
slot stays held until the reply or the end of the session. The gateway logs a
warning once a cancel has gone unacknowledged for the cancel grace period
(default 30s). It does not force-disconnect or free the slot. Driver: an
over-subscribed worker is worse than a temporarily smaller one, and a forced
disconnect would fail that worker's other, healthy invokes.

**Rollout: 4B (lockstep, protocol `2.0`).** Driver: every connected worker is
known to honour `Cancel`, so the gateway never has to reason about workers that
ignore it. The cost is an ordering rule; see Consequences.

## Design

### Proto (`sidecar_gateway.proto`)

- `Cancel` gains `CancelReason reason = 2`, an enum of `UNSPECIFIED`,
  `STATE_EXITED`, `TIMEOUT`, `SHUTDOWN`. Its "not yet wired up" comment is
  replaced by the semantics below.
- `InvokeError.error.code = "CANCELLED"` (non-retriable) is the agreed reply
  from a handler that stopped because of the token.
- The sidecar protocol version becomes `"2.0"`, sent in
  `Register.protocol_version` and `RegisterAck.gateway_protocol_version`.

### Gateway

- **In-flight index.** `invoke()` takes the claimed message's `queue_name` and
  `msg_id`. The gateway keeps an index `(queue_name, msg_id)` → set of
  `invoke_id`. It is a set because a redelivered message can be in flight twice
  on one gateway while an earlier invoke is waiting for its cancel
  acknowledgement.
- **Cancelling an invoke** (any trigger): push `Cancel { invoke_id, reason }` on
  the worker's stream, and move the invoke from "pending" to "cancelling". A
  cancelling invoke still counts toward `inFlightOf` (slot held), but nothing is
  waiting on its promise any more:
  - `STATE_EXITED`: the invoke's promise rejects with
    `ActivityInvokeError("CANCELLED", retriable = false)`. `dispatchAndArchive`
    treats `CANCELLED` as done and does not call
    `finish_async_operation_event_v2` (SPEC-011): the message is already
    archived. If it did call it, the gate would discard the result anyway.
  - `TIMEOUT`: the promise rejects as today (`TIMEOUT`, retriable), so the
    message is left for redelivery, and the `Cancel` is sent as well.
  - `SHUTDOWN`: the promise rejects as today (`WORKER_DISCONNECTED`), the
    `Cancel` is pushed before the stream ends, and no acknowledgement is
    awaited.
- **The worker's reply to a cancelling invoke** (`InvokeError CANCELLED`, any
  other `InvokeError`, or `InvokeResult`) frees the slot and is dropped: it is
  never archived and never sent to the parent. The gateway logs it and writes
  the acknowledgement row (see Observability).
- **Cancel grace.** If a cancelling invoke has no reply after
  `--cancel-ack-grace-ms` (default 30 000), log a warning once. Nothing else
  happens.
- **LISTEN.** New flag `--listen-db-url` / `PGFSM_LISTEN_DB_URL`. When set, the
  gateway opens one dedicated `pg.Client` (outside the pool) and runs
  `LISTEN fsm_async_operation_cancel`. It reconnects with backoff, and runs a
  sweep immediately after each (re)connect to cover the gap. A notification
  whose `(queue_name, msg_id)` isn't in this gateway's index is ignored, which
  is how several replicas coexist. When the flag is unset, the gateway logs at
  startup that cancellation works by sweep only. It never LISTENs through
  `--db-url`.
- **Sweep.** Every `--cancel-sweep-interval-ms` (default 5 000; `0` turns the
  sweep off), and only while the index is non-empty, the gateway calls one new
  SQL function through the normal pool with the pending (not already cancelling)
  pairs. The function returns the pairs no longer present in their pgmq queue
  tables, and each one is cancelled with `STATE_EXITED`. With the gate, a
  pending message can only disappear through a cancel: its completion goes
  through this gateway, and a redelivered copy's earlier invoke is already
  cancelling, so it isn't swept.
- **Protocol gate.** A `Register` whose `protocol_version` major is not `2` gets
  `RegisterAck { accepted: false }`, an error log naming the worker and its
  version, and the stream is ended.

### SDKs: one handler shape per language, every handler gets a token

| SDK    | Handler signature                                                                         | Token                                                                                                                         |
| ------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| TS     | `(input: unknown, signal: AbortSignal) => unknown \| Promise<unknown>`                    | `AbortSignal`; `signal.reason` carries the `CancelReason`                                                                     |
| Go     | `func(ctx context.Context, input any) (any, error)`                                       | `ctx` is cancelled; `context.Cause(ctx)` carries the reason                                                                   |
| Python | `Callable[[Any, CancellationToken], Any]`                                                 | SDK-defined `CancellationToken` with `cancelled`, `reason`, `wait(timeout)`, `raise_if_cancelled()` (handlers run on threads) |
| Rust   | `Box<dyn Fn(Value, CancellationToken) -> Value + Send + Sync>` (runs in `spawn_blocking`) | SDK-re-exported token with `is_cancelled()`, `reason()`, and an async `cancelled()` for handlers that bridge to async code    |

Common SDK rules:

- On `Cancel { invoke_id }`, cancel that invoke's token. An unknown `invoke_id`
  (already finished) is ignored.
- When the handler returns or throws after its token was cancelled: a successful
  return is still sent as `InvokeResult`, so the gateway learns it completed
  anyway. A throw or error is sent as `InvokeError` with code `CANCELLED`.
  Either reply acknowledges the cancel.
- When a `Session` ends (EOF, GOAWAY, error), the SDK cancels the tokens of
  every invoke it still has running for that session, with reason `SHUTDOWN`:
  their results could no longer be delivered anyway.
- `protocol_version` is `"2.0"`. A `RegisterAck { accepted: false }` is logged
  as an error and the SDK exits non-zero rather than reconnecting in a loop.

### Scaffolds

`fsm-compiler-ts`'s per-language handler scaffolds (Eta templates) generate the
new signatures, with a one-line comment on checking the token. `test-apps/` are
regenerated.

### Observability

- **Gateway logs:** when a `Cancel` is sent (actor key, `invoke_id`, queue and
  msg id, reason, trigger source: LISTEN or sweep), when it is acknowledged
  (outcome `aborted` | `completed` | `failed`, ms from cancel to ack), and the
  grace warning.
- **Event-log row on acknowledgement:** a new SQL function inserts a row into
  `fsm_async_operation_queue_event_logs` with `event_name = 'cancel_ack'`,
  `event_status = 'cancel_acknowledged'`, the queue name and msg id, and
  `event_data = {invoke_id, reason, outcome, cancel_to_ack_ms}`. It is written
  through the normal pool. A write failure is logged and never blocks the slot
  release. No row is written for `SHUTDOWN` cancels, whose replies can't arrive.
  A state-exit cancel of an in-flight message therefore shows the `canceled` row
  from `finish_async_operation_event_v2` and, later, the `cancel_acknowledged`
  row.

## Consequences & migration

- **Breaking change to every SDK's handler signature.** Every actor in every
  language needs a one-line signature change (the token can be ignored). Each
  SDK gets a semver-major release, and the scaffolds and test apps change with
  them.
- **Rollout order is fixed: SDKs first, then the gateway.** A `2.0` worker works
  against a `1.0` gateway: it registers, and the old gateway never sends
  `Cancel`. A `2.0` gateway rejects `1.x` workers. So upgrade and redeploy every
  worker, then the gateway. Upgrading the gateway first takes every
  not-yet-upgraded actor offline until its worker is upgraded. Each release note
  and the gateway README say this.
- **SPEC-011 ships first.** The gateway's switch to
  `finish_async_operation_event_v2` and the gate are SPEC-011's; this spec only
  adds the listener, the sweep, `Cancel` and the SDK side.
- **One extra Postgres connection per gateway replica** when `--listen-db-url`
  is set, and it must bypass the transaction pooler. Without it, cancellation
  still works with up to one sweep interval of latency.
- **Two new SQL functions:** the sweep check and the ack log. They follow
  `docs/schema-change-propagation.md`.
- **Handlers that ignore the token** gain nothing except a dropped late result,
  and they keep their slot until they finish. That is visible in the
  acknowledgement's `completed` outcome.
- **Still at least once.** A cancel can arrive after the handler's side effect
  but before it returns; that case is unchanged.
- **Rollback.** The gateway can be rolled back alone only if workers are kept on
  `2.0` (compatible with the old gateway). Rolling SDKs back to `1.x` needs the
  gateway rolled back first. The SQL functions are additive and can stay. A
  softer fallback without a release: unset `--listen-db-url` and set
  `--cancel-sweep-interval-ms=0` to stop state-exit cancels while keeping the
  rest.

## Acceptance criteria

- [ ] `sidecar_gateway.proto` has `Cancel.reason` (`CancelReason` enum) and
      protocol version `2.0`; generated stubs for all four languages are
      regenerated.
- [ ] The gateway sends `Cancel { reason: STATE_EXITED }` to the worker running
      a message within one second of the cancel committing when
      `--listen-db-url` is set, and within one sweep interval when it isn't.
- [ ] With the listener connection killed during a cancel, the sweep still
      cancels the invoke, and the listener reconnects.
- [ ] Behind a transaction-mode pooler, with `--listen-db-url` unset,
      cancellation works through the sweep, and the startup log says so.
- [ ] With two gateway replicas, only the replica that dispatched the message
      sends `Cancel`; the other logs nothing above debug.
- [ ] No `xstate.done.actor.*` / `xstate.error.actor.*` event for a
      `STATE_EXITED`-cancelled invoke reaches the parent queue.
- [ ] An invoke timeout sends `Cancel { reason: TIMEOUT }` and still leaves the
      message for redelivery.
- [ ] `stop()` and the max-age drain deadline send `Cancel { reason: SHUTDOWN }`
      to every invoke still running before ending its stream.
- [ ] The slot of a cancelled invoke stays counted in `inFlightOf` until the
      worker replies; a reply (any kind) frees it and is not archived; a missing
      reply logs one warning after the cancel grace.
- [ ] Each SDK (TS, Python, Rust, Go) passes a token to every handler, cancels
      it on `Cancel` and when the session ends, replies `CANCELLED` for a
      handler that throws after cancellation, and `InvokeResult` for one that
      returns anyway. Each SDK's tests cover both.
- [ ] Each SDK sends `protocol_version: "2.0"` and exits non-zero on
      `RegisterAck { accepted: false }`. The gateway rejects a `1.0` register.
- [ ] Every acknowledged non-shutdown cancel writes one
      `fsm_async_operation_queue_event_logs` row with
      `event_status = 'cancel_acknowledged'` and the reason, outcome, and
      latency.
- [ ] `fsm-compiler-ts` scaffolds generate the new handler signature in all four
      languages, and `test-apps/` are regenerated and pass.

End to end:

- [ ] An FSM whose state exits (through an `after` delay) while its actor is
      running gets the handler aborted. In each language, the handler observes
      its token, the side effect after the check does not happen, and the FSM
      ends in the post-exit state with no late actor event processed.

## Implementation

1. #537 (PR #554): proto `Cancel.reason` and protocol `2.0`; the gateway's
   in-flight index, cancelling state, slot release on reply, `TIMEOUT` /
   `SHUTDOWN` triggers and protocol gate. Released as `proto-v0.3.0`.
2. #538 (PR #555): gateway `STATE_EXITED` detection: the `--listen-db-url`
   listener, the sweep, and the SQL sweep function.
3. #539 (PR #556): the SQL ack-log function and the gateway's write.
4. #540 (PR #559): TS SDK, released as `@pgfsm/async-worker-sdk` 0.4.0.
5. #541, #542, #543 (PR #560): Python, Rust and Go SDKs, released as 0.4.0.
6. #544 (PR #571): `fsm-compiler-ts` scaffolds and `test-apps/` on the 0.4 SDKs,
   released in `@pgfsm/compiler` 0.4.0.
7. #545: end-to-end test, `spec012Cancel/v01/spec012-journey-test.ts`: in each
   language the handler observes its token, the side effect after the check
   doesn't happen, and the FSM ends in the post-exit state.

The gateway release carrying (1)–(3), 0.5.0, ships last: it rejects workers
below protocol 2.0.
