# SPEC-014: Error Policy for Sync Operations

| Field   | Value                                                                                                                       |
| ------- | --------------------------------------------------------------------------------------------------------------------------- |
| Status  | Accepted                                                                                                                    |
| Date    | 2026-10-29                                                                                                                  |
| Authors | Niraj, Claude (Opus 5.5)                                                                                                    |
| Issue   | #590                                                                                                                        |
| Affects | `packages/fsm-sync-worker-ts` (macrostep, worker loop, fsmlet options), `packages/fsm-compiler-ts` (scaffolded entry), docs |

Related: SPEC-010 (internal event queue, status `error` for unhandled actor
errors, #520), SPEC-011 (a terminal status stops invokes and timers), SPEC-013
(input mappers), SPEC-007 (retriable actor failures in the async poll loop),
ADR-002 (sync worker), ADR-003 (connection minimization).

---

## Problem

Sync operations are the TypeScript functions the sync worker runs inside a step:
guards, actions, delays, and (SPEC-013) input mappers. When one of them throws,
what happens depends on which kind it is:

| A sync operation…            | pgfsm today                                                                                                                                                                                                                        | XState v5                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **guard throws**             | Not caught. The message isn't archived, so pgmq redelivers it after its visibility timeout (30 s), forever. Meanwhile the worker reads the next message and processes it, out of order. An internal event is retried every second. | status `error`, the actor stops |
| **delay function throws**    | Same as a guard                                                                                                                                                                                                                    | status `error`                  |
| **action throws**            | Logged and skipped; the step completes with the context unchanged                                                                                                                                                                  | status `error`                  |
| **input mapper throws**      | Logged; the actor gets `null` (SPEC-013)                                                                                                                                                                                           | status `error`                  |
| guard has no implementation  | Logged; counts as `false`                                                                                                                                                                                                          | throws, so status `error`       |
| action has no implementation | Silently skipped                                                                                                                                                                                                                   | silently skipped                |
| delay has no implementation  | Logged; the event is sent now                                                                                                                                                                                                      | raised without a delay          |

XState's behaviour is verified in 5.32.5: `Actor._process` wraps
`logic.transition` in a `try`, and on any throw keeps the previous snapshot with
`status: 'error'` and the error, notifies observers' `error`, and stops. Nothing
the failed transition computed is applied.

The guard and delay rows are the bug. For example, a guard
`isAdult = (context) => context.user.age >= 18` on an instance whose `user` is
undefined:

- XState: the actor goes to `error`; you see it.
- pgfsm: the `APPROVE` event is redelivered every 30 s indefinitely. A later
  `CANCEL` is processed before it. The instance stays `active`, and nothing but
  a log line says it's broken.

The action and input-mapper rows are the inconsistency: the same kind of bug (an
exception in user code) silently carries on there, possibly down the wrong path.

**In scope:** what happens when a sync operation **throws**. **Out of scope**
(follow-ups): missing implementations (the last three rows, which a startup
check like SPEC-006's could catch before any instance runs), and recovering an
instance from `error`.

## Constraints

1. **Status `error` exists.** The instance row has `fsm_instance_status` and
   `fsm_instance_error`; status `error` stops the instance's worker (#520).
   SPEC-010 uses it for unhandled actor errors and the internal-event cycle cap,
   and under SPEC-011 a terminal status stops the instance's invokes and timers.
   No schema change is needed to reuse it.
2. **A step is saved by one archive call.** The fsmlet computes a step in
   TypeScript and saves it, with its status and error, in a single archive call
   (`unhandledActorError` already works this way). Recording an error costs no
   extra database round trip (connection minimization, ADR-003).
3. **Definitions are immutable per version** (SPEC-006). This spec changes the
   worker, not `fsm.json`, so it applies to running instances as soon as their
   worker is upgraded.
4. **Sync operations can do I/O.** Actions and guards receive `deps` (a database
   pool) and the message. A throw isn't always a bug in the function: it can be
   a transient database failure. XState can treat every throw as fatal because
   its actions run in memory.
5. **One worker per instance, events in order.** An instance's worker holds its
   lock and takes events one at a time: internal events first, then its pgmq
   queue in order. Anything that skips past a failing event breaks that order.

## Options considered

### Option A — Fail fast (XState)

The first throw sets status `error` and the worker stops.

- Pro: identical to XState, simple, no ordering problem.
- Con: one database blip permanently errors an instance (constraint 4).

### Option B — Cap pgmq redelivery, then `error`

Keep today's mechanism (leave the message, pgmq redelivers it after the
visibility timeout) and set `error` once its `read_ct` passes N.

- Pro: least code; the count survives a worker crash.
- Con: while the message is invisible, the worker reads and processes the next
  one. Out-of-order processing, half of the original bug, stays.

### Option C — Retry in place, then `error`

The worker keeps the failing event and retries the step itself, with backoff,
taking nothing else for that instance until the step succeeds or N attempts
fail. Then status `error`, as in XState.

- Pro: order is kept; transient failures are absorbed; the end state is XState's
  (`maxAttempts: 1` is exactly XState).
- Con: the instance is blocked for up to N attempts; its fsmlet slot stays busy
  meanwhile (it holds no database connection while waiting).

### Option D — Log and carry on everywhere

Catch every throw: a guard counts as `false`, a delay sends now, an action is
skipped.

- Pro: smallest change; nothing ever stalls.
- Con: a bug or a database blip silently takes the wrong branch (an
  `isPaymentValid` guard that throws takes the "invalid" path), and the instance
  looks healthy.

### Where N is configured (for B and C)

1. **In `fsm.json`**: every fsmlet agrees on it, but changing it needs a new FSM
   version (SPEC-006), plus a schema change, a migration and compiler support,
   and it has no XState equivalent.
2. **In the sync worker, per FSM**: a `startFsmlet` / `runFsmlet` option.
   Changing it is a redeploy. During a rolling deploy two fsmlets may use
   different N briefly, which changes only how many attempts are made.
3. **Per instance**: a new `fsm_instance` column and a parameter on
   `create_fsm_instance_from_name_v2`, `@pgfsm/db`, `pgfsmctl` and the API. It
   can be added later as an override without breaking anything.

## Decision

**Option C, with N configured in the sync worker per FSM (default 3).**

Decision drivers:

- **Order** (constraint 5) rules out B: retrying by redelivery lets later events
  overtake the failing one.
- **Transient I/O** (constraint 4) rules out A as the default: a single blip
  shouldn't end an instance. A stays available as `maxAttempts: 1`.
- **Visibility** rules out D: a persistent failure must stop the instance in
  `error`, as XState does, not take a branch silently.
- **N is operational, not part of the machine's meaning** (how hard to try, not
  what the transitions are), so it belongs with the worker, not in the immutable
  definition. Per instance adds a database release chain for no current use
  case.

Sync operations are still **expected to be pure**: I/O belongs in actors. The
retry absorbs the transient failures that slip through; it isn't a licence for
side effects in actions.

### Behaviour

1. **What counts.** The worker wraps each call to a guard, action, delay
   function or input mapper; a throw from one of them is a **sync operation
   error**, carrying `kind` (`guard | action | delay | input`), `name` and the
   thrown error. Anything else that fails during a step (Postgres unreachable, a
   pgmq error, the archive call) is a **platform error**.
2. **Retry in place.** On a sync operation error the worker discards the step
   and runs it again from the start, with the same event and the instance as it
   was before the step. It reads no other event for that instance meanwhile.
   Waits between attempts start at 1 s and double (1 s, 2 s, …), capped at 30 s.
   The message's visibility timeout isn't extended: only the worker holding the
   instance's lock (`fsm_instance_lock`) reads its queue, so a message that
   becomes visible again isn't read by anyone else meanwhile.
3. **The whole step re-runs.** Operations that ran before the one that threw run
   again: a step is computed in memory and saved once, so there's no partial
   step to resume from. This is why actions must be pure or idempotent.
4. **Counting.** For a pgmq event the first attempt's number is the message's
   `read_ct`, and each retry in place adds one. A worker that crashes and
   restarts mid-retry therefore carries on counting instead of starting again,
   and every delivery gets at least one attempt. Internal events (not pgmq
   messages) count in memory from 1.
5. **Platform errors never count.** They're retried in place with the same
   backoff, capped at 30 s, and never set `error`. A database outage must not
   turn every instance that was mid-step into a permanent error.
6. **After N failed attempts** the worker saves, in one archive call:
   - the state and context as they were before the step (nothing from the failed
     step is applied, as in XState);
   - status `error`, and `fsm_instance_error` set to
     `{ kind, name, message, attempts, eventType }`;
   - the message archived (consumed), so it is never redelivered;
   - no new invokes or timers. The archive's terminal-status path (SPEC-011,
     steps 8 and 11) then does what it does for any `error`: stops the
     instance's invokes, archives its timers and the messages left on its queue,
     and, for a child FSM, sends `xstate.error.actor.<invoke id>` to the parent,
     whose `onError` can handle it.

   The worker then releases the instance (#520). `error` is final, as in XState.
7. **Success after a failure** saves the step normally; nothing records the
   earlier attempts except the logs.
8. **Configuration.** A new `FsmletOptions.syncOperationRetry`:

   ```ts
   await runFsmlet(dbConfig, SYNC_OPERATION_REGISTRATIONS, FSM_DEFINITIONS, {
     signal: controller.signal,
     syncOperationRetry: {
       maxAttempts: 3, // every FSM this fsmlet serves (default 3)
       fsms: { creditCheck: { maxAttempts: 5 } }, // per FSM, all its versions
     },
   });
   ```

   It goes in the user-owned `run-sync-worker.ts`, not the generated registries
   (they're rewritten on every compile). `maxAttempts` must be an integer ≥ 1;
   anything else fails `startFsmlet` before it connects.
9. **Unchanged:** missing implementations (all three rows), a delay function
   that returns something other than a number of milliseconds (the event is sent
   now), and an input mapper that's missing (the actor gets `null`).

## Consequences & migration

- **Breaking for anyone relying on today's "log and continue".** An action or
  input mapper that throws on every attempt now ends the instance in `error`
  instead of carrying on. `@pgfsm/sync-worker` gets a minor bump (pre-1.0) with
  a release note naming both. Guards and delay functions that throw stop
  retrying forever and end in `error` too, which is the fix.
- **Side effects in actions run up to N times.** Already true today for a step
  redelivered after a crash; the spec now states it: actions must be pure or
  idempotent.
- **A failing instance holds its fsmlet slot** for the retries: about 3 s at the
  default, longer during a platform outage (by design, since nothing can
  progress then anyway).
- **Generated projects:** the compiler's scaffolded `run-sync-worker.ts` shows
  `syncOperationRetry` commented out with its default. Existing projects keep
  their entry file (it's never overwritten) and get the default of 3.
- **No database or definition change**, so no migration and no new FSM versions.
- **Rollback:** deploy the previous `@pgfsm/sync-worker`. Instances that ended
  in `error` under this spec stay in `error`.
- **Follow-ups:** a startup check that every guard, delay and input mapper named
  in a served `fsm.json` has a registration (missing implementations); a way to
  recover an instance from `error` (it must decide what re-running a step whose
  actions had side effects means); optionally a per-instance override of N.

## Acceptance criteria

- [ ] A guard, action, delay function or input mapper that throws is retried in
      place with the same event and the instance as it was before the step, up
      to `maxAttempts`, waiting 1 s, then 2 s, doubling, capped at 30 s.
- [ ] While retrying, the worker takes no other event for that instance: a test
      sends two events, makes the first one's guard throw once and then succeed,
      and sees them processed in order.
- [ ] After `maxAttempts` failed attempts: status `error`; `fsm_instance_error`
      is `{ kind, name, message, attempts, eventType }`; state and context are
      unchanged from before the step; the message is archived; no invokes or
      timers are started and existing ones are stopped; the worker releases the
      instance.
- [ ] A child FSM that ends in `error` this way sends
      `xstate.error.actor.<invoke id>` to its parent, carrying the saved error,
      and the parent's `onError` transition is taken.
- [ ] A step that succeeds after failed attempts is saved exactly as if it had
      succeeded first time.
- [ ] Platform errors (e.g. the database unreachable during a step) are retried
      with backoff capped at 30 s and never set `error`; a test fails the
      archive call several times and then lets it through.
- [ ] A pgmq event's attempt count starts at its `read_ct`: a message
      redelivered with `read_ct = maxAttempts` gets one attempt and, if it
      throws, sets `error`. Internal events count from 1.
- [ ] `syncOperationRetry.maxAttempts` (default 3) and `fsms.<name>.maxAttempts`
      are honoured; `maxAttempts: 1` sets `error` on the first throw; an invalid
      value fails `startFsmlet` before it connects.
- [ ] A throwing action and a throwing input mapper no longer carry on: both end
      in `error` after `maxAttempts`.
- [ ] Missing implementations behave as before (guard false, action skipped,
      delay sent now, input `null`).
- [ ] The scaffolded `run-sync-worker.ts` documents `syncOperationRetry`; the
      sync worker's README and CLAUDE.md describe the policy; the release note
      names the breaking change.

## Implementation

Accepted with #617. Two details changed during implementation (#618): waits
between sync operation retries are capped at 30 s like platform retries, and the
visibility timeout isn't extended (the instance lock already keeps other workers
off the queue), so no new `@pgfsm/db` function is needed.

- #618: (a) sync worker: retry in place, then status `error`.
- #619: (b) compiler: the scaffolded `run-sync-worker.ts` documents
  `syncOperationRetry`.
- #620: (c) end-to-end test.

Follow-ups: #621 (startup check for missing implementations: the fsmlet refuses
to start when a guard, named delay or input mapper has no registration), #622
(recover an instance from `error`), #623 (per-instance `maxAttempts`).
