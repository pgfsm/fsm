# SPEC-010: `done.state` Events Through a Per-Instance Internal Event Queue

| Field   | Value                                                                                                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status  | Draft                                                                                                                                                                              |
| Date    | 2026-10-18                                                                                                                                                                         |
| Authors | Niraj, Claude (Opus 5.5)                                                                                                                                                           |
| Issue   | #504                                                                                                                                                                               |
| Affects | `packages/database-src` (`microstep_v2`, the archive function, `fsm_instance`, the SQL `macrostep_v2` / `fsm_worker_v2`), `packages/fsm-sync-worker-ts`, `packages/fsm-core-db-ts` |

Related: #506 (`microstep_v2` follows XState's `microstep`), #510 (transition
selection), #500 (`done` for a top-level final state), #458 (acceptance suite,
whose `loadTest` needs this), #512 / #514 (cancelling actors), #516 (`after`
delays).

---

## Problem

XState raises an internal event, `xstate.done.state.<id>`, when a compound
state's active child becomes a **final** state, and when **every** region of a
parallel state has done so. A state's `onDone` is a transition on that event,
and XState processes it straight away: `enterStates` (`stateUtils.ts`) pushes it
onto the internal queue, and `macrostep` drains that queue before the step ends,
before any other event is looked at.

Here, one queued event runs **one microstep** (`macrostepV2` in
`packages/fsm-sync-worker-ts/src/fsmlet/fsmworker-helper.ts` calls
`microstep_v2` once), and the state is saved. Nothing checks whether a final
state was entered, and no `done.state` event is ever created. So `onDone` on a
compound or parallel state never fires, and an FSM whose flow continues through
one stays in it for good:

- **`loadTest`** (#458): the parallel `Working` ends with all four regions in
  `Done`, and never moves to `Finished`. `recordFinished` never runs, and the
  instance is never marked `done`, so its worker slot stays taken (#500 only
  frees it on a top-level final state).
- **`creditCheck` v01:** the parallel `CheckingCreditScores` ends with all three
  bureau regions in `FetchingComplete`, and stops there.

Every full-cycle run so far has needed
`pgfsmctl instance send -e xstate.done.state.<id>` by hand. That isn't a fix:
the state is saved half-done, other events can be processed in between (in the
wrong order, see [Constraints](#constraints)), and a cascade needs one hand-sent
event per level.

The same macrostep gap also leaves **completion** incomplete. When the machine
reaches a top-level final state, XState runs the remaining states' exit actions
and stops its children; here they don't run, and invoked actors keep their
queued messages. An `xstate.error.actor.*` event that no transition takes should
set status `error`, as XState's `macrostep` does; here it's consumed with no
change (#510).

## Constraints

- **Orchestrator vs activity split** (ADR-003, `CLAUDE.md`): the sync worker
  (fsmlet, TypeScript) is the only database-touching tier, and it's where guards
  and actions run. Postgres can't call them, so anything that needs a guard or
  an action between microsteps involves the worker.
- **At-least-once delivery** (ADR-003): pgmq with a visibility timeout can
  deliver an event twice after a crash. Whatever is saved must be consistent at
  every save point, so a replay is clean.
- **Connection minimisation** (`CLAUDE.md` point 4, ADR-003): extra round trips
  on the instance's connection are fine; extra connections or per-instance
  infrastructure are not. The worker already holds the instance's lock and a
  connection for the whole event (ADR-002 Stage 3).
- **Access control** (database ADR-001, SPEC-009 §1): new or changed entry
  points are `SECURITY DEFINER` with a pinned `search_path`; helpers are not
  executable by PUBLIC.
- **XState is the reference** (#506): `microstep_v2` and its helpers mirror
  `stateUtils.ts` step by step, and this spec keeps that.
- **Still in development:** `fsm_core` functions may change signature, and
  loaded data needs no backfill. The database migration and the
  `@pgfsm/sync-worker` release ship together; no compatibility with the released
  0.3.x is required.

Decided during the design (the reasons are under [Decision](#decision)):

- **Internal events are processed before events already waiting in the
  instance's queue**, XState's internal-queue rule. An event that arrives after
  the one that finished a region must not overtake the `done.state` it caused.
- **One save (archive transaction) per microstep**, with that microstep's raised
  events saved in the same transaction.

No accepted ADR conflicts with this spec.

## Options considered

All options share one piece. `microstep_v2` computes the microstep's
**`raised_events`**, a port of `enterStates`' final-state handling: for each
final state entered, in entry order, `done.state.<parent>` when the parent is
compound, then `done.state.<parallel>` for each enclosing parallel state all of
whose regions are now final, going up through nested parallel states; each
parallel state at most once per microstep. That is the only place that knows
both inputs the rule needs: which final states were **entered** in this
microstep (XState raises on entering a final state, not on being in one), and
the **whole configuration afterwards** (to check every region). The same place
already computes `done` (#500).

The archive function was also considered as the place to compute them. It loses:
it only receives the saved state value, so it would need the entered nodes and
the configuration passed back (more data, not less, and a second copy of
`enterStates` semantics in the persistence function), and without "entered" it
would raise again on every later event while a region sits in a final state.

The options differ in where the raised events wait and who drives the loop.

### Option A — Internal queue on the instance row

A new column, `fsm_instance.internal_event_queue` (a JSON array). The archive
appends the microstep's `raised_events` to it, in the same transaction as the
state. The worker takes the next internal event from the instance row before
reading the instance's pgmq queue, runs it through the same macrostep, and the
archive removes it from the head of the queue in that event's transaction.

- **Pros:** internal events first; each microstep and its raised events saved
  atomically; no new queue per instance; a small worker change; the pending
  internal events are visible on the instance (debugging, `pgfsmctl`).
- **Cons:** a frequently written JSON column on the instance row; needs a cycle
  cap so a looping FSM can't grow it forever; the worker has two event sources.

### Option B — A second pgmq queue per instance

Each instance also gets an internal pgmq queue. The archive sends
`raised_events` there; the worker reads it before the main queue.

- **Pros:** internal events first; pgmq's semantics, visibility timeout and
  metrics for free; atomic with the archive (`pgmq.send` in the same
  transaction).
- **Cons:** one more queue (pgmq creates tables per queue) for **every**
  instance, with its creation, cleanup and monitoring, against ADR-003's cost
  per instance; two queue reads per event.

### Option C — Loop in the worker, in memory

The worker keeps `raised_events` in memory and calls `microstep` again for each,
building up the state, context, actions and queue changes, and archives **once**
at the end of the cascade.

- **Pros:** internal events first; no schema change; one save per queued event.
- **Cons:** breaks the per-microstep save point decided above; the most worker
  logic (accumulating actions and queue bookkeeping across microsteps); the
  internal events are invisible while they run.

### Option D — `done.state` on the normal queue (the smaller step)

The archive sends `raised_events` to the instance's normal pgmq queue.

- **Pros:** no worker change, no schema change, atomic per microstep.
- **Cons:** first in, first out: an event that arrives after the one that
  finished a region is processed before the `done.state` it caused. With
  `Working: { on: { CANCEL: 'Cancelled' }, onDone: 'Finished' }`, a `CANCEL`
  sent just after the last region's actor result makes the instance end in
  `Cancelled` instead of XState's `Finished`. The outcome depends on timing.

## Decision

**Option A — a per-instance internal event queue on the `fsm_instance` row.**

Decision drivers:

- **Ordering** rules out D: XState's outcome must not depend on timing.
- **Per-microstep atomicity** rules out C: every microstep, with the events it
  raised, is a consistent save point, which keeps at-least-once replays clean
  and keeps the worker's per-event logic as it is.
- **Cost per instance** (ADR-003) rules out B: a column, not a queue, per
  instance.

Details decided with it:

1. **`microstep_v2` returns `raised_events`**, in XState's order, each as an
   event object (`{ "eventType": "xstate.done.state.<id>" }`). A final state's
   `output` is not attached: it's usually a function, and functions aren't in
   `fsm.json`.
2. **The worker passes `raised_events` to the archive unchanged**; it does
   nothing else with them.
3. **The archive** appends them to `internal_event_queue` in the same
   transaction as the state, and, for an internal event, removes it from the
   head of the queue instead of archiving a pgmq message. It therefore knows the
   event's source: a pgmq message id, or the internal queue.
4. **The worker takes the next internal event before reading pgmq**, and handles
   it exactly like a queued event (selection, guards, `microstep_v2`, actions,
   archive).
5. **Completion.** When `microstep_v2` reports `done` (a top-level final state),
   it also returns the remaining states' exit actions, deepest first, with their
   invokes as cancels of the actors' queued messages (#512's channel; real
   in-flight cancellation is #514), and the internal queue is cleared. When an
   `xstate.error.actor.*` event selects no transition, the worker saves status
   `error` and stops the instance's worker.
6. **Cycle cap.** The instance counts the internal events processed since the
   last external event. Past a limit (100, configurable later), it saves status
   `error` with an infinite-loop message, like XState's `maxIterations`.
7. **Logging.** Each internal event is logged in the instance's event logs with
   `source = internal`, so a cascade can be traced.
8. **The SQL path** (`macrostep_v2` / `fsm_worker_v2`, not used by TypeScript)
   is updated to raise and process `done.state` the same way, so both paths
   behave alike.

### Non-goals

- **Eventless `always` transitions:** XState's `StateNode.definition`, which the
  compiler serializes, has no `always`, so they never reach `fsm.json`;
  supporting them needs a compiler change first.
- **User-written `raise`:** XState serializes built-in actions as just
  `{ type: 'xstate.raise' }`, without the event, so it can't be replayed from
  `fsm.json` either. The `after` delayed raise the compiler generates is a
  separate bug (#516).
- **Several transitions per microstep** (one per parallel region): selection
  keeps "the first runs, with a warning" (#510) until a later spec.
- **Wildcard event descriptors** (`*`, `foo.*`).
- **A final state's `output` as `done.state` event data.**
- **History states.**

## Consequences & migration

- **Schema:** a new
  `fsm_instance.internal_event_queue jsonb NOT NULL DEFAULT
  '[]'` (and the
  cycle counter), in a new `fsm_core` migration. Existing instances start with
  an empty queue, so they behave as today until they next enter a final state.
- **Function shapes change:** `microstep_v2`'s result gains `raised_events` (and
  the completion exit actions); the archive gains the raised events and the
  event's source. `database.types.ts` and the `@pgfsm/db` wrappers follow.
- **The worker gets a second event source.** Its loop reads the instance row's
  internal queue first; logs and errors say which source an event came from.
- **The worker and the database must match.** A new worker on an old database
  would call the archive with the wrong signature; an old worker on a new
  database would ignore the internal queue, and a cascade would stall as it does
  today. The migration and the `@pgfsm/sync-worker` release ship together.
- **Hand-sent `done.state` events still work** (they're ordinary events), so the
  current workaround stays harmless during the rollout.
- **Rollback:** the column is additive. Reverting the functions leaves it
  unused; a later migration can drop it. Instances with pending internal events
  at that point would lose them, which is the stalled state they'd be in today.
- **What gets harder:** reasoning about one instance now means its queue plus
  its internal queue; a cascade is several archive transactions instead of one
  step, so an observer can see the intermediate states (each one consistent).

## Acceptance criteria

`microstep_v2` (pgTAP):

- [ ] Entering a final state whose parent is compound returns `raised_events` =
      `[xstate.done.state.<parent>]`.
- [ ] When the last region of a parallel state enters a final state, it returns
      `done.state.<region>` and then `done.state.<parallel>`, and cascades
      through nested parallel states.
- [ ] When several regions enter final states in the same microstep, the
      parallel state's `done.state` appears once.
- [ ] Entering a non-final state, or a final state while another region isn't
      final, raises nothing for the parallel state.
- [ ] Reaching a top-level final state returns `done: true`, the remaining
      states' exit actions (deepest first) and their invokes as cancels.

The archive and the internal queue (pgTAP):

- [ ] The archive appends `raised_events` to `internal_event_queue` in the same
      transaction as the state; a rolled-back archive leaves both unchanged.
- [ ] Processing an internal event removes it from the head of the queue, and no
      pgmq message is archived.
- [ ] Each internal event is logged with `source = internal`.
- [ ] Past the cycle cap, the status becomes `error` with an infinite-loop
      message.

The worker:

- [ ] Internal events are taken before pgmq messages (test: a `CANCEL` queued
      behind the event that finishes the last region doesn't overtake the
      `done.state`).
- [ ] An unhandled `xstate.error.actor.*` event sets status `error` and stops
      the instance's worker.

End to end:

- [ ] **`loadTest`:** 10/10 instances reach `Finished` and `done`, with
      `recordFinished` run, and no hand-sent `done.state` (#458).
- [ ] **`creditCheck` v01:** after `Submit`, the instance moves past
      `CheckingCreditScores` with no hand-sent `done.state`.

The SQL path:

- [ ] `macrostep_v2` / `fsm_worker_v2` raise and process `done.state` the same
      way; their pgTAP shows the same cascade as the worker's.

## Implementation

<!-- Filled in after acceptance: links to implementation issues and PRs. -->
