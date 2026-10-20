# SPEC-011: Stop an In-Flight Invoke When Its State Exits

| Field   | Value                                                                                                                                                                                                                                                                                                |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status  | Draft                                                                                                                                                                                                                                                                                                |
| Date    | 2026-10-20                                                                                                                                                                                                                                                                                           |
| Authors | Niraj, Claude (Opus 5.5)                                                                                                                                                                                                                                                                             |
| Issue   | #514                                                                                                                                                                                                                                                                                                 |
| Affects | `packages/database-src`, `packages/fsm-async-worker-gateway-ts`, `packages/fsm-proto-codegen` (`sidecar_gateway.proto`), `packages/fsm-async-worker-sdk-{ts,python,rust,go}`, `packages/fsm-sync-worker-ts`, `packages/fsm-core-db-ts`, `packages/fsm-compiler-ts` (handler scaffolds), `test-apps/` |

Related: #532 (a child FSM's error event carries its context; step 11's
payload), #512 (the cancel notification's fixed channel), #510 (a late actor
result is consumed with no change), #523 / #526 (invoked child FSMs are real
instances, started through `start_invoked_async_operation_v2`), #396 (retriable
failures are redelivered), SPEC-007 (gateway behind a transaction pooler,
connection drain), SPEC-010 (internal event queue).

---

## Problem

When a state exits, `archive_event_from_fsm_type_worker_v2` step 4 handles every
stopped invoke the same way: it calls
`cancel_event_for_fsm_async_operation_type_worker_v2`, which archives the
invoke's start message with `pgmq.archive` and notifies
`fsm_async_operation_cancel` with `{"queue_name", "msg_id"}`. That only stops
work that hasn't started, and it's wrong for one of the two kinds of invoke.

**Actors (`internalAsyncOperation`, `sharedAsyncOperation`).** The gateway
claims messages with a visibility-timeout read, not a delete, so a message that
has been handed to a worker is still in its queue. The cancel's archive
succeeds, but nothing tells the worker. The handler runs to completion, side
effects included. Its result then reaches
`archive_event_from_fsm_async_operation_type_worker_v2`, whose `pgmq.archive`
returns false but which still sends `xstate.done.actor.*` to the parent, and
since #510 the parent consumes it with no change. Nothing listens to the
notification, and `Cancel { invoke_id }` in `sidecar_gateway.proto` is never
sent; the SDKs accept it and ignore it.

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

**Child FSMs (`fsm`).** Step 4 sends a child FSM through the same actor cancel
function. That archives the child's start event if it is still queued. It also
writes the cancel row into the wrong table
(`fsm_async_operation_queue_event_logs`, keyed by the child's id) and fires
`fsm_async_operation_cancel`, which means nothing for an FSM. A child that has
already started keeps running, along with its own actors, children and delayed
events. When it finishes, archive step 9 sends `xstate.done.actor.<invoke id>`
to the parent, as for a late actor result. `start_child_fsm_v2` already notes
"Stopping a child that is already running is a follow-up (#514)".
`stop_event_for_fsm_worker_v2` doesn't fill the gap: it only deletes
`pending`/`scheduled` dispatch rows. It doesn't mark the instance stopped, so
the child is dispatched again as soon as its next event arrives.

**A stale result can be taken for a new invoke's result.** When the invoking
state is entered again, a new actor or child is started under the **same invoke
id**, as XState does. The parent matches results by name alone
(`xstate.done.actor.<invoke id>`). If the old invoke's completion commits before
the parent's exit, its done event is already in the parent's queue. The parent
exits, re-enters, starts a new invoke X, then reads the stale `done.actor.X` and
treats the **new** invoke as finished.

**The macrostep save can't stop safely.**
`archive_event_from_fsm_type_worker_v2` is where every one of the fixes above
has to take effect, and today it can't support them:

1. **It takes its row lock late.** The first `FOR UPDATE` is at step 6b, after
   steps 1–6 have archived schedules, cancelled invokes and started new ones.
   Those steps work on `input_total_*_queue_data`, the totals the fsmlet read
   earlier, and step 7 writes values derived from them back over the row. A stop
   that lands while a macrostep is in flight can't be seen in time, and step 7
   then overwrites the totals the stop cleared.
2. **A terminal status leaves invokes and schedules running.** When the saved
   status is `done` or `error`, entries left in the totals keep running. The
   internal-event cycle cap sets `error` only after step 6 has already started
   this macrostep's invokes. XState stops all of an actor's children when it
   finishes or fails. (`pgfsmctl instance stop` has the same gap: it only
   removes the dispatch row.)
3. **Step 8 ignores `pgmq.archive`'s result.** If the processed message was
   already archived (a redelivery after its visibility timeout, or a stop), the
   macrostep has been applied a second time. Steps 3 and 4 also ignore their
   archive results and always report success.
4. **The internal-event head check raises.** A stop clears
   `internal_event_queue`, so a macrostep racing it hits the "not the head"
   `RAISE` instead of being discarded.
5. **The lock mode can deadlock against a child.**
   `fsm_instance_queue_event_logs.fsm_instance_id` is a foreign key to
   `fsm_instance`, so inserting a parent's log row takes `FOR KEY SHARE` on the
   parent row, which conflicts with `FOR UPDATE`. A child's archive holds the
   child row and, in step 9, waits for the parent row to log the notification.
   At the same time, the parent's archive holds the parent row and waits for the
   child row to stop it. Postgres detects the deadlock and aborts one of them.

Who is affected: any FSM whose actors or child machines have side effects
(payments, emails, external calls) and whose states can exit before the invoke
finishes. That includes every `after` timeout racing an invoke (#516), any state
that is re-entered while an invoke is running, and any actor that can time out
or be caught by a gateway restart.

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
- **XState semantics.** Stopping an actor stops its whole subtree and cancels
  its delayed events. A stopped actor sends its parent nothing. Re-entering a
  state starts a fresh actor under the same invoke id.
- **Lock order.** The parent's archive holds the parent row and then works on
  its children. Anything a child does must not take a lock on the parent row
  that conflicts with the parent's, or the two can deadlock. A child does
  implicitly take `FOR KEY SHARE` on the parent: every event-log insert for the
  parent checks its foreign key. So instance rows must be locked
  `FOR NO KEY UPDATE`, which doesn't conflict with `FOR KEY SHARE` and is what a
  plain `UPDATE` of non-key columns takes anyway, never `FOR UPDATE`.
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

### 5. Finishing an actor message: completion and cancel

**A. Keep two functions.**
`archive_event_from_fsm_async_operation_type_worker_v2` (completion) and
`cancel_event_for_fsm_async_operation_type_worker_v2` (cancel) each do their
side effects whatever `pgmq.archive` returned. A cancel and a completion racing
on one message both act: the late result is sent to the parent (relying on #510
to discard it), and a `Cancel` is sent to a worker that has already finished.

**B. One function, gated on `pgmq.archive`.** A single function takes the reason
(`completed` or `cancelled`) and does its side effects only when its own
`pgmq.archive` returned true. `pgmq.archive` deletes the message row, so two
transactions racing on one message serialise on its row lock, and exactly one of
them wins. Costs a signature change (`DROP` + `CREATE`) and a schema migration.

### 6. Stopping a child FSM

**A. Call `stop_event_for_fsm_worker_v2`.** Already exists. But it only deletes
pending dispatch rows: a running child keeps running, is dispatched again on its
next event, isn't marked stopped, and its own invokes and delayed events
continue.

**B. A new `stop_child_fsm_v2`.** Marks the child stopped, clears its queue and
dispatch, stops its invokes recursively, and the child's archive discards any
macrostep saved after the stop. More code, but it is what XState's stop means.

### 7. Rejecting a stale done/error event from an earlier invoke

**A. Child-side check in archive step 9.** Before notifying, the child locks the
parent row (`FOR SHARE`) and checks that the parent still holds this child.
Covers only the case where the parent's exit commits first. It locks child, then
parent, against the parent archive's parent-then-child order, so it can
deadlock. And it does nothing for actors.

**B. Parent-side check on the event's source.** Every `xstate.done.actor.*` /
`xstate.error.actor.*` event carries the invoke it came from. The parent drops
the event when its current entry for that invoke id doesn't match. Covers both
commit orders, takes no extra lock, and treats actors and child FSMs alike.

### 8. Making the macrostep save safe

**A. Patch the guards into today's order.** Add a `stopped` check after the 6b
lock, and check step 8's archive result. Smallest diff, but the lock still comes
after the invokes have started. The totals still come from the caller, and the
cycle cap still flips the status after the starts. Each guard would be working
around the order rather than relying on it.

**B. Reorder the whole function.** Lock first (`FOR NO KEY UPDATE`), gate on
status and on the processed message before any side effect, work from the row's
totals, decide the final status before the entry side, and stop the subtree on a
terminal status. A rewrite of one function, but every guard then holds by
construction.

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

**Finishing an actor message: 5B (one function, gated).** Driver: the race
between a cancel and a completion is resolved in the database, by the row lock,
instead of by every consumer downstream. Cancel wins: the late result is never
sent to the parent. Completion wins: no `Cancel` is sent to a finished worker.
5A loses because both sides act and the consumers have to clean up.

**Stopping a child FSM: 6B (`stop_child_fsm_v2`).** Driver: XState semantics. A
stopped child stops its subtree and never reports back. 6A loses because a
running child carries on.

**Stale events: 7B (parent-side source check).** Driver: it is the only option
that covers both commit orders and both kinds of invoke. 7A loses on coverage,
and on lock order.

**Macrostep save: 8B (reorder).** Driver: the stop, the stale-event check and
exactly-once processing all need the same thing: to be decided under the lock,
before any side effect. 8A loses because the lock would still come after the
starts. See "Target sequence" below.

### Design: database

#### `finish_async_operation_event_v2` (replaces the two actor functions)

```
fsm_core.finish_async_operation_event_v2(
    input_archive_reason text,          -- 'completed' | 'cancelled' (CHECK)
    input_async_operation_queue_name text,
    input_async_operation_queue_msg_id bigint,
    -- completion only, DEFAULT NULL:
    input_event_name, input_event_action_type, input_event_output,
    input_send_to_parent_queue_id, …, input_event_status, input_error_message,
    input_execution_started_at, input_execution_duration, input_execution_finished_at
) RETURNS jsonb
```

1. `archived := pgmq.archive(queue, msg_id)`.
2. If `archived`:
   - `completed`: if `input_send_to_parent_queue_id` is a real parent (the
     existing system-queue checks), send the result with
     `send_event_to_fsm_queue_with_event_logs_v2`. The message carries the
     event's **source**, `{invoke_id, queue_id: <queue name>, queue_msg_id}`
     (see "Stale done/error events"). `completed` means "the worker finished",
     whether it succeeded (`xstate.done.actor.*`) or failed
     (`xstate.error.actor.*`, including the archive after the last delivery
     attempt).
   - `cancelled`:
     `pg_notify('fsm_async_operation_cancel', {"queue_name",
     "msg_id"})`,
     delivered when the transaction commits.
3. Always write one `fsm_async_operation_queue_event_logs` row. Its
   `event_status` is the outcome (`succeeded` / `failed` / `canceled`) when
   `archived`, and `discarded` when not, with the reason in `event_data`. A
   dropped late result stays visible.
4. Return `{archive_result, reason, status, …}`.

The gateway calls it with `completed`.
`cancel_event_for_fsm_async_operation_type_worker_v2` and
`archive_event_from_fsm_async_operation_type_worker_v2` stay as thin wrappers,
marked deprecated, so the deprecated v1 worker (`fsm-async-worker-ts`, `.ts` and
`.py`) needs no change. This is a schema change: follow
`docs/schema-change-propagation.md` (types, `fsm-core-db-ts`'s
`asyncOperationCtl.ts`, the gateway's `asyncOpPollLoop.ts`,
`test-apps/e2e/tools/load.ts`,
`packages/database-src/docs/reference/pg-ts-function-mapping.md`).

#### `stop_invoked_async_operation_v2` (step 4's dispatcher)

The mirror of `start_invoked_async_operation_v2`. It takes one entry from
`total_async_operation_queue_data` and branches on its `async_operation_type`:

- `internalAsyncOperation` / `sharedAsyncOperation`:
  `finish_async_operation_event_v2('cancelled', entry.queue_id, entry.queue_msg_id)`.
- `fsm`: `stop_child_fsm_v2(entry.queue_id::uuid)`.
- anything else: `RAISE EXCEPTION`, as the start function does.

`archive_event_from_fsm_type_worker_v2` calls it for each invoke of an exited
state (step 5b of the target sequence) and for every invoke left when the
instance reaches a terminal status (step 8). Today's step 4 calls the actor
cancel function directly.

#### `stop_child_fsm_v2(input_child_fsm_instance_id uuid)`

1. `SELECT … FOR NO KEY UPDATE` the child row (see Constraints: lock order). If
   it's not found, or its status is already `done` / `error` / `stopped`, return
   without doing anything.
2. Read its `total_async_operation_queue_data`, then set
   `fsm_instance_status = 'stopped'` and clear `internal_event_queue`,
   `total_schedule_queue_data` and `total_async_operation_queue_data`.
3. Delete its `pending` / `scheduled` rows in `fsm_instance_and_fsm_workerlet`
   (the body of `stop_event_for_fsm_worker_v2`, reused).
4. Archive **every** message on the child's queue
   (`SELECT msg_id FROM pgmq.q_<child id>`, then
   `pgmq.archive(queue, msg_ids)`), not only the delayed events in
   `total_schedule_queue_data`. Events other actors or the API sent, and a
   message an fsmlet is processing right now (invisible, but still in the
   queue), go too. Archiving rather than purging keeps the audit trail.
5. For each entry read in step 2, call `stop_invoked_async_operation_v2`, so the
   child's actors and grandchildren stop too.
6. Write one `fsm_instance_queue_event_logs` row on the child
   (`event_name = 'stop_child'`, `event_status = 'stopped'`, `event_data` with
   the parent id and invoke id).

It does not notify the parent: a stopped actor reports nothing. It locks only
rows below the caller (child, then grandchildren), which matches the parent
archive's order.

The same steps, without the parent-specific log fields, are what stopping any
instance means. `stop_child_fsm_v2` is a thin wrapper over a general
`stop_fsm_instance_v2(input_fsm_instance_id uuid, input_reason text)`. The
target sequence's terminal-status step uses the same subtree-stop logic, and
`pgfsmctl instance stop` can move onto it later (outside this spec).

#### Target sequence for `archive_event_from_fsm_type_worker_v2`

This replaces today's order. It all runs in one transaction. The order still
decides which lock is taken when, which decision gates which side effect, and
that the exit side runs before the entry side (a re-entered state reuses its
ids).

| #  | Step                                                                                                                                                                                                                                                                             | Why here                                                                                                                                                                                             |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | **Lock the instance**: `SELECT … FOR NO KEY UPDATE`. Missing row: raise.                                                                                                                                                                                                         | Everything below works on locked state, serialised with a stop and with a duplicate fsmlet. The mode avoids the foreign-key deadlock (Constraints: lock order).                                      |
| 2  | **Status gate.** If the row's status isn't `active`, archive the processed pgmq message (if any), log `discarded`, and return `{discarded: true, reason: <status>}`.                                                                                                             | A stopped or finished instance takes no more macrosteps. Comes before the internal-queue head check, because a stop clears that queue.                                                               |
| 3  | **Consume the processed input, gated.** A pgmq message: read it (for its source), then `pgmq.archive`. If that returns false, log `discarded` and return. An internal event: if it isn't the queue's head, log `discarded` and return (instead of raising). Otherwise remove it. | Exactly once per message. False means another fsmlet already applied it, or a stop archived it. This gate is the `stopped` guard for a macrostep that was already in flight when the stop committed. |
| 4  | **Stale-event check** (see "Stale done/error events"). For `xstate.done.actor.X` / `xstate.error.actor.X` with a source that doesn't match the row's current entry for X: log `stale_actor_event` and return.                                                                    | Under the parent's own lock, after the message is consumed. The transition the fsmlet computed is discarded, which is the same as XState ignoring the event.                                         |
| 5  | **Exit side**, from the **row's** totals: (a) archive the cancelled schedules' messages; (b) stop the exited invokes with `stop_invoked_async_operation_v2`. Remove both from the totals, and record each archive's real result.                                                 | XState runs exit actions first. Old entries must be gone before new ones with the same id are added. The input totals are only checked against the row; a mismatch is logged.                        |
| 6  | **Decide the final status**: the fsmlet's status, overridden by the internal-event cycle cap (→ `error`).                                                                                                                                                                        | Decided before anything is started, so nothing is started only to be stopped.                                                                                                                        |
| 7  | **Entry side, only if the final status is `active`**: (a) schedule delayed events; (b) start invokes with `start_invoked_async_operation_v2`. Add both to the totals.                                                                                                            | A finished or errored machine starts nothing.                                                                                                                                                        |
| 8  | **If the final status is terminal** (`done` / `error`): stop every invoke left in the totals, archive every remaining schedule and every message left on the instance's own queue, and clear the totals.                                                                         | XState stops all of an actor's children when it finishes or fails.                                                                                                                                   |
| 9  | **Internal event queue**: if `active`, append the raised events; otherwise clear it.                                                                                                                                                                                             | As SPEC-010.                                                                                                                                                                                         |
| 10 | **Save the row**: status, state, context, XState snapshot, totals, internal queue and count, error.                                                                                                                                                                              | After steps 5–8, whose message ids and entries are what get saved.                                                                                                                                   |
| 11 | **Notify the parent** if the status is `done` / `error` and there is one, with the source `{invoke_id: parent_invoke_id, queue_id: <this instance's id>}`. Never lock the parent row explicitly.                                                                                 | Last, so it reflects the final status. A stopped instance never gets here (step 2).                                                                                                                  |
| 12 | **Return** the result, including `discarded` and its reason.                                                                                                                                                                                                                     | The fsmlet treats a discard as success, not as an error, and logs it.                                                                                                                                |

How the race between a stop and a macrostep resolves (both take the instance
lock first):

- **The stop wins:** it archives every message on the queue, including the one
  being processed, and sets `stopped`. The macrostep then stops at step 2.
- **The macrostep wins:** it saves normally. The stop then runs on the saved
  state and stops whatever that macrostep started.

#### Re-entry: a new child per start

`start_child_fsm_v2` keeps creating a **new** `fsm_instance` each time the
invoking state is entered, as XState starts a fresh actor. The previous child
was stopped by `stop_child_fsm_v2` when the state exited. A transition that
doesn't exit the state starts nothing.

#### Stale done/error events

Every `xstate.done.actor.<invoke id>` / `xstate.error.actor.<invoke id>` message
carries its **source** next to the event data (not inside it, so the event
payload XState sees doesn't change):

- an actor result: `{invoke_id, queue_id: <actor queue name>, queue_msg_id}`,
  set by `finish_async_operation_event_v2`;
- a child FSM's result: `{invoke_id, queue_id: <child instance id>}`, set by
  step 11 of the target sequence.

When the parent saves the macrostep for an `xstate.done.actor.*` /
`xstate.error.actor.*` event (step 4 of the target sequence), it looks up its
current `total_async_operation_queue_data` entry for that invoke id. It discards
the macrostep if there's no entry, or if the entry's `queue_id` (and
`queue_msg_id`, for actors) doesn't match the source. The message was already
archived in step 3, and the event log records `stale_actor_event`. Messages
without a source (from before this change) are processed as today.

The check runs in SQL, under the parent's own row lock, rather than in the
fsmlet before XState sees the event. The fsmlet's read of the totals would be
unlocked and could already be stale, and in SQL one check covers every fsmlet.
The cost is that the fsmlet computes a transition that is then thrown away,
which is rare and cheap.

This covers both orderings of the race described in the Problem. It works for
actors and children alike, and takes no lock beyond the parent's own row. A
child-side check was rejected (option 7A) because of lock order.

### Design: gateway, proto and SDKs

#### Proto (`sidecar_gateway.proto`)

- `Cancel` gains `CancelReason reason = 2`, an enum of `UNSPECIFIED`,
  `STATE_EXITED`, `TIMEOUT`, `SHUTDOWN`. Its "not yet wired up" comment is
  replaced by the semantics below.
- `InvokeError.error.code = "CANCELLED"` (non-retriable) is the agreed reply
  from a handler that stopped because of the token.
- The sidecar protocol version becomes `"2.0"`, sent in
  `Register.protocol_version` and `RegisterAck.gateway_protocol_version`.

#### Gateway

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
    `finish_async_operation_event_v2`: the message is already archived. If it
    did call it, the gate would discard the result anyway.
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

#### SDKs: one handler shape per language, every handler gets a token

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

#### Scaffolds

`fsm-compiler-ts`'s per-language handler scaffolds (Eta templates) generate the
new signatures, with a one-line comment on checking the token. `test-apps/` are
regenerated.

#### Observability

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
- **Database rows:** `discarded` (a completion that lost to a cancel, or a
  cancel that lost to a completion), `stop_child` / `stopped` on a stopped
  child, and `stale_actor_event` on a parent that dropped a stale result.

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
- **Database changes ship first** and work with the current gateway and SDKs:
  the old function names stay as wrappers, the gate only drops results the
  parent discarded anyway, and stopping children and the stale-event check need
  nothing from the gateway.
- **One extra Postgres connection per gateway replica** when `--listen-db-url`
  is set, and it must bypass the transaction pooler. Without it, cancellation
  still works with up to one sweep interval of latency.
- **New SQL functions:** `finish_async_operation_event_v2`,
  `stop_invoked_async_operation_v2`, `stop_child_fsm_v2`, the sweep check and
  the ack log, and `stop_fsm_instance_v2` behind `stop_child_fsm_v2`.
  `archive_event_from_fsm_type_worker_v2` is reordered to the target sequence,
  including the stale-event check and the notification's source. The fsmlet
  learns to treat a `discarded` result as success. All of it follows
  `docs/schema-change-propagation.md`.
- **The input totals become a check.** The fsmlet still passes
  `input_total_*_queue_data` (no signature change for the reorder), but the
  function works from the row and only logs a mismatch. Dropping the parameters
  is a later cleanup.
- **Terminal instances now stop their subtree.** An FSM that reaches `done` or
  `error` with invokes still running stops them. Today they keep running and
  report to a finished parent. This is a behaviour change, and the XState one.
- **A stopped child FSM loses its queued messages** (archived, not processed).
  That is XState's behaviour for a stopped actor, but anything that sends events
  to a child by id should expect it.
- **Handlers that ignore the token** gain nothing except a dropped late result,
  and they keep their slot until they finish. That is visible in the
  acknowledgement's `completed` outcome.
- **Still at least once.** A cancel can arrive after the handler's side effect
  but before it returns; that case is unchanged.
- **Rollback.** The gateway can be rolled back alone only if workers are kept on
  `2.0` (compatible with the old gateway). Rolling SDKs back to `1.x` needs the
  gateway rolled back first. The database changes are behind new function names
  and wrappers, and can be reverted by a migration that restores step 4's direct
  call, step 9 and the old function bodies. A softer fallback without a release:
  unset `--listen-db-url` and set `--cancel-sweep-interval-ms=0` to stop
  state-exit cancels while keeping the rest.

## Acceptance criteria

Database:

- [ ] `finish_async_operation_event_v2` exists. When its `pgmq.archive` returns
      false it neither sends to the parent (`completed`) nor notifies
      (`cancelled`), and it logs `discarded`. When the archive returns true it
      behaves as the two old functions did. pgTAP covers both orders of a
      completion/cancel race.
- [ ] The two old function names are wrappers over it, and the v1 worker still
      works.
- [ ] Exiting a state calls `stop_invoked_async_operation_v2`. An actor entry is
      cancelled through `finish_async_operation_event_v2`, a `fsm` entry through
      `stop_child_fsm_v2`, and an unknown type raises.
- [ ] `stop_child_fsm_v2` on a running child sets `stopped`, removes its pending
      dispatch, archives every message on its queue (including delayed and
      in-flight ones), stops its actors and grandchildren recursively, logs
      `stop_child`, and sends the parent nothing. On an already finished or
      stopped child it does nothing.
- [ ] `archive_event_from_fsm_type_worker_v2` follows the target sequence: it
      locks the instance `FOR NO KEY UPDATE` before any side effect, and works
      from the row's totals.
- [ ] A macrostep saved for an instance that isn't `active` is discarded (no
      starts, stops, schedules, state change or parent notification) and returns
      `discarded`. The fsmlet treats that as success.
- [ ] A macrostep whose pgmq message was already archived is discarded, so the
      same message is never applied twice. pgTAP covers a duplicate save. A
      macrostep whose internal event is no longer the queue's head is discarded
      instead of raising.
- [ ] When the final status is `done` or `error` (including the cycle cap), no
      invoke or schedule is started. Every remaining invoke is stopped, and
      every remaining schedule and queued message is archived.
- [ ] Steps 5a and 5b record each archive's real result: the `_failed` arrays
      are filled when an archive returns false.
- [ ] A parent and a child saving at the same moment, the parent exiting the
      invoking state while the child finishes, never deadlock. pgTAP or a
      concurrent test runs both orders.
- [ ] Re-entering an invoking state creates a new child `fsm_instance`; the old
      one is `stopped`.
- [ ] A stale `xstate.done/error.actor.<id>` (from an actor or a child, queued
      before or after the parent's exit) is dropped by the parent and logged
      `stale_actor_event`, and the new invoke under the same id is unaffected. A
      message without a source is processed as before.

Gateway, proto, SDKs:

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
- [ ] An FSM whose state exits while its invoked child FSM is running stops the
      child (and the child's own running actor). The parent receives no
      `done.actor` for it.
- [ ] An FSM that re-enters an invoking state while the first invoke is
      finishing ends driven only by the second invoke's result.

## Implementation

To be cut after acceptance. The database issues (1–3) don't depend on the
gateway and ship first.

1. `finish_async_operation_event_v2` with the archive gate, wrappers for the two
   old names, and the gateway switched to it; schema-change propagation.
2. `archive_event_from_fsm_type_worker_v2` reordered to the target sequence
   (lock first in `FOR NO KEY UPDATE`, status and archive gates, totals from the
   row, final status before the entry side, terminal subtree stop), with
   `stop_invoked_async_operation_v2`, `stop_fsm_instance_v2` /
   `stop_child_fsm_v2`, and the fsmlet's handling of `discarded`.
3. Sources on done/error events (actor and child) and the stale-event check
   (step 4 of the target sequence).
4. Proto `Cancel.reason` and protocol `2.0`; the gateway's in-flight index,
   cancelling state, slot release on reply, `TIMEOUT` / `SHUTDOWN` triggers and
   protocol gate.
5. Gateway `STATE_EXITED` detection: the `--listen-db-url` listener, the sweep,
   and the SQL sweep function.
6. The SQL ack-log function and the gateway's write.
7. TS SDK.
8. Python SDK.
9. Rust SDK.
10. Go SDK.
11. `fsm-compiler-ts` scaffolds and `test-apps/` regeneration.
12. End-to-end tests: actor cancel in each language, child FSM stop, re-entry.
