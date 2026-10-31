# SPEC-015: Deterministic Simulation Testing

| Field   | Value                                                                                                                                                                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status  | Draft                                                                                                                                                                                                                                                                                                   |
| Date    | 2026-10-31                                                                                                                                                                                                                                                                                              |
| Authors | Niraj, Claude (Opus 5.5)                                                                                                                                                                                                                                                                                |
| Issue   | #639                                                                                                                                                                                                                                                                                                    |
| Affects | new `packages/fsm-sim-ts` (`@pgfsm/sim`), `packages/database-src` (clock seams), `packages/fsm-core-db-ts` (transaction seam), `packages/fsm-sync-worker-ts`, `packages/fsm-async-worker-gateway-ts`, `packages/fsm-async-worker-sdk-{ts,python,rust,go}`, `packages/fsm-proto-codegen` (`SimHost`), CI |

Related: ADR-002 (fsmlet / scheduler / lease model), ADR-003 (at-least-once,
push-assign + lease, connection minimization, polyglot activity tier), SPEC-002
(proto ownership), SPEC-003 (pg_cron scheduler), SPEC-007 (gateway deployment
and its E2E suite, #458), SPEC-008 (async actor liveness), SPEC-010 to SPEC-014
(the protocol changes this is meant to guard).

---

## Problem

pgfsm is a distributed protocol: competing fsmlets claim instances with
`FOR UPDATE SKIP LOCKED`, a pg_cron scheduler push-assigns over `pg_notify`,
`lock_fsm_instance` leases sit underneath, pgmq redelivers after a visibility
timeout, and an Activity Gateway relays invokes, results and cancels to actor
workers in four languages. Its worst bugs depend on **timing and faults**, and
every one of them so far was found by a person, not a test:

| Bug  | What happened                                                                                                       | Trigger                               |
| ---- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| #546 | Identical consecutive `done.state` events could be applied twice                                                    | redelivery / ordering                 |
| #500 | The sync worker never marked an instance done, so its slot never freed and new instances starved                    | a lifecycle path never taken in tests |
| #396 | Retriable invoke failures (`WORKER_DISCONNECTED`, `TIMEOUT`) were archived as actor errors instead of re-dispatched | worker disconnect mid-invoke          |
| #392 | SDK workers didn't reconnect to the gateway sidecar socket                                                          | socket drop                           |
| #484 | The TS SDK hung instead of retrying when the TLS gateway refused the connection                                     | connection refused                    |
| #397 | `SidecarGateway.stop()` hung while a worker was connected                                                           | shutdown with a live connection       |

Today's tests can't find this class of bug:

- The journey and XState comparison tests
  (`apps/fsm-core-example/fsm/*/…-test.ts`) run in real time against real
  Postgres and exercise **one interleaving per run**, whichever the OS happens
  to produce.
- The stress harness (`packages/database-src/scripts/stress/`) measures
  throughput, not correctness.
- When something does fail intermittently, there is nothing to replay.

Every SPEC-010 to SPEC-014 change touched this protocol (internal event queue,
stop-on-exit, cancel, input, error policy), and more are queued (#521, #622,
#623). Each one is a fresh chance for a timing bug that ships.

**Goal.** One harness that:

1. **finds** protocol bugs by searching interleavings and faults,
2. makes every failure **replayable** from a seed, and
3. backs a **CI gate** that stops regressions.

Deterministic simulation testing (DST) does exactly this. The whole system runs
under a simulator that owns every source of nondeterminism (time, scheduling,
randomness, network, crashes), so a run is a pure function of its seed. The
technique comes from FoundationDB and is now used by TigerBeetle, Turso, Rust's
`madsim` / `turmoil`, and Antithesis.

## Constraints

- **Postgres is the source of truth** (ADR-003, CLAUDE.md). State, locks and
  queues live in `fsm_core` SQL. A simulator that fakes the database would test
  the wrong layer: the riskiest code is the SQL.
- **At-least-once delivery** (ADR-003). pgmq's visibility timeout plus
  redelivery means every macrostep and actor must be idempotent, and that is the
  main property to test.
- **Push-assign with a lease underneath** (ADR-002, ADR-003). Dispatch timing
  lives partly inside Postgres: the scheduler is a pg_cron job (SPEC-003),
  assignment goes over `pg_notify`, and leases use `now()`.
- **Polyglot activity tier** (ADR-003, SPEC-007). TS, Python, Rust and Go SDKs
  talk to the gateway over TCP. The **real SDK code** must be under test, not a
  stand-in (see [Decision](#decision)).
- **Production behaviour must not change.** Every seam this spec adds is a no-op
  unless sim mode is explicitly on.
- **Connection minimization** (CLAUDE.md goal 4). The simulator must not need a
  connection model different from production. Each simulated actor uses the
  connections it would use for real, and the harness checks the bound.
- **Dev on macOS, CI on Linux.** Determinism must hold on both.
- Proto contracts live in `fsm-proto-codegen` (SPEC-002).

No accepted ADR is superseded. This spec adds a test architecture and seams
around the existing execution model without changing the model itself.

## Options considered

### Option A: In-house simulator driving real SQL and real SDK subprocesses

A Deno simulator (`@pgfsm/sim`) holds a seeded RNG and a virtual clock, and
steps every actor itself: fsmlets, the scheduler function, the async-op poll
loop, the gateway sidecar, and **real SDK worker processes**. SDKs run in an
env-gated sim mode that routes their clock, timers, RNG and gateway connection
through a `SimHost` control channel. Postgres is real, with virtual time
supplied through clock seams and transactions interleaved by the simulator.

- **Pros:** Real code everywhere that matters (SQL, TS loops, all four SDKs).
  One seed reproduces the whole system, including interleavings that involve two
  different SDKs at once. Owned in-repo, runs per PR and offline.
- **Cons:** The largest build: a seam in four SDKs, a control protocol,
  quiescence tracking, and restructuring the poll loops as step functions. Races
  _inside_ Postgres or inside one SDK's own concurrency are explored only at the
  boundaries the seams expose.

### Option B: Antithesis (hypervisor-level determinism)

Run the real docker-compose (Postgres, gateway, all SDKs) inside Antithesis's
deterministic hypervisor and add its SDK assertions for the invariants.

- **Pros:** Full determinism, including Postgres internals and each SDK's
  internal scheduling. Very little seam code.
- **Cons:** A paid external dependency, with code and data leaving the repo. It
  suits a nightly or on-demand run, not a per-PR gate, and doesn't run on a
  laptop for local replay.

### Option C: Hybrid, full-system sim with a TS stand-in worker plus per-SDK conformance sims

A full-system simulator like A, but the actor worker is an in-sim TypeScript
stand-in that speaks the gateway protocol. Each real SDK is tested **alone**
against a seeded, fault-injecting simulated gateway. With only one process, that
is deterministic without an SDK seam.

- **Pros:** Medium cost. Each piece is simple and fast. Every SDK's
  gateway-protocol handling (#392, #484) is still covered.
- **Cons:** The stand-in drifts from the real SDKs, so system interleavings run
  against code that isn't shipped. It can't reach bugs that need two real SDKs
  in one interleaving, such as an op redelivered to a worker in a different
  language after a visibility timeout.

### Option D: Smaller hammer (property tests plus chaos)

fast-check property tests on macrostep, `@std/testing/time` `FakeTime` unit
tests for timers, and chaos testing (toxiproxy, pod kills) on SPEC-007's kind
suite.

- **Pros:** Small. Uses real SDKs in the chaos suite.
- **Cons:** No replayable seed. Chaos runs are random rather than searched, and
  a failure seen once may never reproduce. This fails goal 2 outright.

## Decision

**Option A.** The deciding driver is that **the real SDK code must be under
test**. A TypeScript stand-in (C) drifts from the four real SDKs. Bugs like #392
and #484 lived in exactly the SDK reconnect and retry code that a stand-in
replaces, and only the shipped code in the full system is trustworthy. B gives
the strongest determinism but is a paid external service that can't back a
per-PR gate or local replay. D gives no replay. B is not ruled out as a later
nightly add-on; the invariant layer below is written to be reusable by it.

The design has six parts.

### 1. Simulator core (`packages/fsm-sim-ts`, `@pgfsm/sim`)

- **Seed → run.** One seed initialises a PRNG that makes every choice: which
  runnable actor steps next, which fault fires, how far the clock advances,
  every UUID and every jitter value.
- **Actors are step functions.** The fsmlet loop (`fsmworker.ts`, `fsmlet.ts`),
  the async-op poll loop (`asyncOpPollLoop.ts`) and the gateway sidecar
  (`sidecar/gateway.ts`) are restructured so one loop iteration is a callable
  `step()`. The production `run()` keeps calling `step()` forever with a real
  clock, so behaviour doesn't change.
- **Event loop.** On each tick the simulator collects the runnable actors (not
  blocked on a lock, a socket or a future timer), picks one with the PRNG, and
  steps it. When none is runnable it advances virtual time to the earliest
  pending timer. Thirty seconds of lease expiry costs microseconds.
- **Trace.** Every step appends a record (actor, action, SQL statement id,
  message, fault, virtual time). The trace hash is the replay check (AC1).

### 2. Virtual time in Postgres

- Two seam functions in `fsm_core`:
  - `fsm_core.tx_now()` replaces `now()` (stable for the transaction).
  - `fsm_core.wall_now()` replaces `clock_timestamp()` (volatile).

  Each returns the value of the `fsm_core.sim_now` GUC when it is set, and
  otherwise calls the real function. The simulator sets the GUC on each actor
  connection before every step.
- All `now()` call sites in `packages/database-src/supabase/schemas/` (about 40
  today: lock and lease stamps, heartbeats, queue logs, archive) move to the
  seams. A prek + CI check rejects raw `now()` / `clock_timestamp()` in
  `fsm_core` SQL outside the seam functions, in the style of
  `scripts/check-pg-types-directive.ts`.
- **pgmq stays pristine.** The vendored `00_pre_ext/…_PGMQ_source.sql` (about 40
  `clock_timestamp()` and 11 `now()` uses, including the visibility-timeout
  arithmetic) is **not** edited. The sim DB build mechanically rewrites those
  calls to the seams when it loads the schema. The rewrite is a small, audited
  script, and pgmq bumps stay clean.
- **pg_cron is not run in sim.** The scheduler job is unscheduled in the sim
  database, and the simulator calls the scheduler function as an explicit step,
  so the PRNG decides when it fires, including "it didn't fire for a while".
- **`pg_notify`.** The simulator owns the `LISTEN` connections. A notification
  is delivered, delayed or dropped as a step. Dropping one is how the lease
  fallback underneath push-assign gets tested.

### 3. Transaction-granularity interleaving

If every SQL call ran to completion before the next began, no two transactions
would ever overlap. The `SKIP LOCKED` branch in
`fsm_claim_scheduled_for_fsmlet.sql` would never run, and neither would any lock
wait in `lock_fsm_instance`, while the run still looked green.

So an actor's transaction may stay **open across steps**:

- `@pgfsm/db`'s client wrapper exposes transaction boundaries to the simulator
  (begin, statement, commit or rollback are separate steps).
- When a statement is issued, the simulator checks whether it is waiting on a
  lock using `pg_blocking_pids()` and `pg_stat_activity.wait_event`. If it is,
  the actor is marked "blocked on X" and the simulator schedules others until X
  commits or aborts. The overlap is real Postgres behaviour; only the order is
  chosen, so it replays.
- A single PL/pgSQL function call is still atomic from the simulator's view.
  Overlap happens between statements and functions, not inside one.
- Deadlocks surface as Postgres deadlock errors on a real overlap and are
  checked like any other outcome.

### 4. SDK sim mode and `SimHost`

- `SimHost` is a versioned proto in `fsm-proto-codegen`. It carries clock reads,
  timer arm and cancel, RNG draws, gateway-socket bytes, and a **blocked
  report** ("waiting on socket", "waiting on timer T", "idle").
- When `PGFSM_SIM_SOCKET` is set, each SDK (TS, Python, Rust, Go) routes its
  clock, sleeps, timers, RNG and gateway connection through `SimHost`, and runs
  one invoke task per step in the order the simulator grants. The blocked report
  gives **explicit quiescence**: the simulator never guesses from silence or
  timeouts.
- When the variable is unset, the SDK uses its normal runtime paths and the sim
  code is never reached.
- **Contract boundary.** Actor code that bypasses the SDK (calls `time.time()`
  or opens its own sockets) is outside the determinism contract. The SDKs expose
  clock and RNG on the actor context for actor authors who want to stay inside
  it. This is documented, not enforced.

### 5. Faults and invariants

**Fault catalogue** (each one chosen by the PRNG, at configurable rates):

- fsmlet or async-op worker crash between transactions, and **inside** a
  transaction while holding locks (`pg_terminate_backend`)
- `pg_notify` dropped or delayed
- scheduler step skipped for a while
- lease and visibility-timeout expiry, by advancing virtual time
- gateway ↔ SDK disconnect, dropped, duplicated or delayed frames
- SDK process crash and restart
- actor throws (SPEC-014 retry path) or exceeds its timeout

**Invariants**, checked after every step or at quiescence:

- at most one lock holder per instance at any time
- no event applied twice; no event lost (event logs vs. what was sent)
- liveness: once faults stop, every queued event is eventually processed and no
  lease stays claimed past expiry
- every async operation reaches a terminal state (finished or cancelled), never
  orphaned (SPEC-008, SPEC-012)
- sync operation attempts never exceed SPEC-014's `maxAttempts`
- the final state matches the **XState oracle**: `transition()` applied to the
  events actually delivered, in the order delivered (the method of today's
  `compare-fsm-macrostep-v2-with-xstate-transition-test.ts`)
- pg connections stay within the configured bound

Invariants are plain functions over the trace and DB state, so an Antithesis
harness could reuse them.

### 6. Failure output and CI

- A failure prints the seed, a **minimised schedule** (shrunk by re-running with
  steps and faults removed until it still fails), and a one-line replay command.
- **Regression corpus.** Every seed that ever failed is committed in-repo with
  the issue it reproduced, and replayed forever.
- **Per PR (blocking).** Corpus plus 200 fresh seeds, capped at about 5 minutes.
- **Nightly.** Thousands of seeds at higher fault rates. A failure files an
  issue automatically with the seed and the minimised schedule.

## Consequences & migration

**What gets harder:**

- Every new `now()`, `clock_timestamp()`, `Date.now()`, `setTimeout`,
  `setInterval`, `Math.random`, `crypto.randomUUID` or socket in our SQL, TS
  workers, gateway and four SDKs must go through a seam. Lint and prek checks
  enforce it, so the cost is paid at review time, not discovered later.
- `SimHost` becomes a versioned contract that four SDKs implement and a shared
  conformance suite tests.
- The poll loops become step functions, which is a real refactor of
  `fsmworker.ts`, `fsmlet.ts`, `asyncOpPollLoop.ts` and `sidecar/gateway.ts`.
- `@pgfsm/db` grows a transaction-boundary hook.
- The seam functions add a function call per timestamp in production. Expected
  to be negligible; the stress harness confirms it (AC2).
- The pgmq sim rewrite must be re-checked on each pgmq bump, as part of the
  bump.

**Migration (vertical slice first):**

1. **Phase 1.** SQL clock seams and lint, the sim pgmq rewrite, the transaction
   seam in `@pgfsm/db`, the simulator core, fsmlet and scheduler as steps, the
   SQL fault set, and the **TS SDK** in sim mode end to end, all on
   `creditCheck` with the XState oracle. The CI gate turns on at the end of this
   phase.
2. **Phase 2.** The gateway sidecar as a step, gateway faults, and the **Python
   SDK** sim mode.
3. **Phase 3.** **Rust and Go SDK** sim modes, plus the remaining example FSMs
   (SPEC-011 to SPEC-014 journeys).

Each phase lands value on its own. The gate runs from the end of phase 1 and
covers more as later phases land.

**Rollback.** Every seam is a no-op with sim mode off, so production is
unchanged at every phase. Abandoning the effort means deleting `@pgfsm/sim` and
the CI jobs. The seams are harmless and can stay or be reverted mechanically. If
the per-PR gate proves too slow or flaky, it drops to non-blocking (or corpus
only) without touching the rest.

## Acceptance criteria

- [ ] **AC1, replay.** The same seed on the same commit produces an identical
      trace hash across two runs, on Linux CI and on macOS.
- [ ] **AC2, production unchanged.** With sim mode off, every existing suite
      passes. pgTAP shows `fsm_core.tx_now()` = `now()` and
      `fsm_core.wall_now()` follows `clock_timestamp()` when the GUC is unset.
      The stress harness shows no meaningful regression.
- [ ] **AC3, seams enforced.** A prek and CI check rejects raw `now()` /
      `clock_timestamp()` in `fsm_core` SQL outside the seam functions, and raw
      `Date.now` / `setTimeout` / `setInterval` / `Math.random` /
      `crypto.randomUUID` in worker and gateway sources outside the clock and
      RNG module. Each SDK has the equivalent check for its language.
- [ ] **AC4, re-finds historical bugs.** With a known fix reverted, the
      simulator fails within the per-PR seed budget: #546 and #500 in phase 1;
      #396, #392, #484 and #397 in phases 2 and 3.
- [ ] **AC5, invariants.** Every invariant in [§5](#5-faults-and-invariants) is
      implemented and checked on every run, including the XState oracle and the
      connection bound.
- [ ] **AC6, overlap is real.** The trace shows the `SKIP LOCKED` skip path and
      lock waits occurring in a meaningful share of seeds (threshold set in
      phase 1). This guards against an "always green, never overlaps" simulator.
- [ ] **AC7, fault catalogue.** Every fault in [§5](#5-faults-and-invariants)
      can be injected and appears in traces.
- [ ] **AC8, usable failures.** A failure prints the seed, a minimised schedule
      and a one-line replay command. The nightly job files an issue
      automatically with that information.
- [ ] **AC9, SimHost.** `SimHost` is a versioned proto in `fsm-proto-codegen`,
      and each SDK's sim mode passes one shared conformance suite.

## Implementation

<!-- Filled in after acceptance: links to implementation issues and PRs. -->
