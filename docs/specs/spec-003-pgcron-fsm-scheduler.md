# SPEC-003: Replace the fsmscheduler TS Process with pg_cron

| Field   | Value                                                  |
| ------- | ------------------------------------------------------ |
| Status  | Accepted                                               |
| Date    | 2026-07-26                                             |
| Authors | Niraj, Claude                                          |
| Issue   | #59                                                    |
| Affects | `packages/fsm-sync-worker-ts`, `packages/database-src` |

---

**Superseded in part by SPEC-016 (#688, #690):** pg_cron is required, and
installing fsm_core registers the job (`register_scheduler_job_v2()`, from
migration 2.3.0); the fallback fsmscheduler process (`pgfsmctl scheduler run`)
is gone, kept only as a test helper
(`apps/fsm-core-example/test-support/fsm-scheduler.ts`).

---

## Problem

`packages/fsm-sync-worker-ts/src/fsmscheduler/fsmscheduler.ts` is a standing
TypeScript process that must run on the control plane alongside the API server.
It holds a dedicated `LISTEN` connection on the `fsm_scheduler_work` channel and
drives `fsm_core.schedule_next_pending()` in a loop, with a 30s fallback poll
for missed notifications (see ADR-002 Stage 3).

This is one more long-running process to deploy, keep alive, and monitor — and
ADR-002 already carries an open TODO ("Explore eliminating the application-level
fsmscheduler") noting the entire scheduling step could happen inside PostgreSQL
instead. There is no acute production incident driving this; it's
operational-overhead reduction plus following up on that TODO. This session
evaluates whether `pg_cron` is the right mechanism to do that, alongside the
inline-call approach ADR-002 already sketched.

## Constraints

- **ADR-003 § Connection accounting** — `fsmscheduler` currently holds exactly
  one dedicated `LISTEN` connection on the control plane. Removing it is a real
  but modest connection-budget win; `fsmlet` nodes keep their own per-node
  `LISTEN` connections regardless, so this does not change the bounded-fleet
  connection story materially.
- **ADR-002 Stage 3 (current architecture)** — the scheduler/kubelet split
  (`fsmscheduler` decides placement, `fsmlet` only executes what it's assigned)
  is the accepted model. This spec does not change that split — it only changes
  _what process_ performs the scheduler's role of periodically calling
  `fsm_core.schedule_next_pending()`. `fsmlet`'s own LISTEN channels
  (`fsm_fsmlet_work_<id>`, `fsm_worker_stop`) are unaffected.
- **ADR-002's own TODO and gate** — the ADR already proposes inlining
  `schedule_next_pending()` into `enqueue_fsm_dispatch_v2()` and sets an
  explicit decision gate: benchmark P99 latency of `schedule_next_pending()`
  under a realistic fsmlet fleet (10–50 nodes); if it stays under 5ms,
  synchronous inline call is safe, otherwise an async path is needed. No such
  benchmark has been run. Any option that reuses this idea inherits that gate.
- **`schedule_next_pending()` is designed for concurrent callers** — it uses
  `SELECT FOR UPDATE SKIP LOCKED`, explicitly to stay correct if multiple
  scheduler replicas call it at once. Whatever mechanism replaces `fsmscheduler`
  should not silently give up that property without noting the trade-off.
- **Draining semantics must be preserved** — the current `runCycle` loop calls
  `scheduleNextPending()` repeatedly until it returns `false`, so one triggering
  event drains the entire queue (not just one entry). Any replacement must
  preserve "drain until empty or no capable fsmlet" as an atomic unit of work
  per invocation, not just "schedule one entry."
- **A purely INSERT-triggered scheduler has no idle-retry path** — if
  `schedule_next_pending()` is only invoked inline from
  `enqueue_fsm_dispatch_v2()` (Option B), a `pending` entry that fails to
  schedule (e.g. all fsmlets briefly full or stale) is only retried as a side
  effect of some _other_ dispatch INSERT happening later (it will be picked up
  first, since `schedule_next_pending()` always claims the oldest `pending`
  row). If dispatch traffic goes quiet system-wide after that point, the entry
  has no trigger to retry it at all and stays `pending` indefinitely — unlike a
  periodic mechanism (Options A/C), which keeps retrying every cycle regardless
  of new traffic. This bears directly on the "worker died, replacement fsmlet
  added" recovery case: if no other instance happens to be enqueuing work in the
  meantime, Option B will not reschedule the stuck entry to the new fsmlet on
  its own.
- **Stale-fsmlet threshold must be preserved** — `schedule_next_pending()` takes
  `input_stale_threshold_seconds` (default 30) to filter out fsmlets with a dead
  heartbeat. Whatever calls it must keep this configurable without a code change
  (currently a CLI flag).
- **Known gap, out of scope: orphaned `scheduled` entries are not reclaimed** —
  once `schedule_next_pending()` assigns an entry (`status='scheduled'`,
  `fsm_workerlet_id` set), only that specific fsmlet's
  `claim_scheduled_for_fsmlet()` call can pick it up. If that fsmlet dies after
  assignment but before claiming, the entry is stuck permanently — no code path
  reclaims `scheduled` rows whose target fsmlet has gone stale.
  `schedule_next_pending()` only ever scans `status='pending'` rows, so this is
  unaffected by which mechanism calls it. This is a pre-existing gap in today's
  architecture (Option A included), not something any of Options A/B/C fix, and
  fixing it is out of scope for this spec — noted here so it isn't mistaken for
  a trade-off between the options below.
- **Latency budget** — a few seconds of added dispatch latency vs. today's
  near-instant `pg_notify` push is acceptable for this workload. This rules
  nothing out — it specifically keeps `pg_cron`'s sub-minute scheduling syntax
  in scope.
- **pg_cron availability** — assumed already enable-able on the target Supabase
  project (dashboard toggle / extension allowlist), not requiring new infra
  approval. This should still be verified as a concrete step before
  implementation, since the exact pg_cron version available determines whether
  true sub-minute (`'N seconds'`) scheduling syntax is supported.

## Options considered

### Option A — Status quo (no change)

Keep `fsmscheduler.ts` as the standing LISTEN/poll process.

**Pros:** Already built, tested, running. Near-instant dispatch via `pg_notify`.
Supports multiple scheduler replicas today (SKIP LOCKED), a property ADR-002
flags as possibly needed for future throughput/sharding.

**Cons:** One more process to deploy/monitor on the control plane. Three-hop
dispatch path (INSERT → notify app → app calls PG → notify fsmlet). Doesn't
address the operational-overhead motivation for this session.

### Option B — Inline call in `enqueue_fsm_dispatch_v2` (ADR-002's TODO)

Call `fsm_core.schedule_next_pending()` directly inside
`enqueue_fsm_dispatch_v2()`, in the same transaction as the INSERT. No standing
process, no LISTEN channel, no cron — single-hop dispatch (INSERT → notify
fsmlet, atomically).

**Pros:** Lowest possible latency (effectively zero added hops). Fully removes
the fsmscheduler process _and_ the `fsm_scheduler_work` channel. Simplest mental
model — scheduling is just part of enqueueing.

**Cons:** Runs synchronously on the enqueue hot path — a slow or contended
`schedule_next_pending()` call (many fsmlets to score, lock contention under
burst) blocks the caller's transaction. ADR-002 flags this explicitly and gates
it on an unbenchmarked P99 <5ms requirement. Also collapses "drain until empty"
into "schedule the one entry we just inserted" — a full drain still needs
_something_ to periodically catch entries that couldn't be scheduled immediately
(e.g., all fsmlets were briefly full) and retry them, so Option B alone doesn't
fully eliminate the need for a periodic sweep.

### Option C — pg_cron periodic drain (this proposal)

Add a SQL wrapper function, e.g.
`fsm_core.schedule_all_pending(stale_threshold_seconds int)`, that loops
`schedule_next_pending()` until it returns `false` (mirrors today's `runCycle`
exactly, just moved into PL/pgSQL). Register it as a `pg_cron` job on a short
interval (e.g. every 5–10s, pending verification of sub-minute syntax support).
Remove `fsmscheduler.ts`, its CLI, and the `fsm_scheduler_work` LISTEN/NOTIFY
channel entirely.

**Pros:** Fully eliminates the standing process and its LISTEN connection — the
original goal. No hot-path blocking risk on the enqueue transaction — `pg_cron`
runs independently of application transactions. Runs entirely inside PostgreSQL;
no application deploy needed to change the schedule (`cron.alter_job`).
Naturally re-sweeps entries that failed to schedule on a prior tick (all fsmlets
briefly full, etc.) without extra logic.

**Cons:** Adds a few seconds of dispatch latency vs. `pg_notify` push (within
the agreed budget). `pg_cron` jobs run from a single scheduler instance by
default — loses the "multiple scheduler replicas" property `SKIP LOCKED` was
written to support, though nothing today actually runs multiple `fsmscheduler`
replicas, so this is a latent property being given up, not an active one.
Observability shifts from structured Pino/logtape logs to `cron.job_run_details`
— a different (and currently unintegrated) monitoring surface. Requires
verifying the installed `pg_cron` version supports the `'N seconds'` schedule
syntax; if not, falls back to minimum 1-minute granularity, still within budget
but coarser.

## Decision

Adopt **Option C (pg_cron periodic drain)** as the near-term default. Rationale:
no steer was requested toward minimizing latency over safety, so the deciding
factor is that Option C carries no unbenchmarked risk — it runs outside
application transactions entirely — while Option B's benefit (near-zero latency)
is only safe to claim once ADR-002's P99 benchmark is done, which hasn't
happened.

**Option B remains a documented future optimization**, not rejected: if a later
benchmark shows `schedule_next_pending()` comfortably clears ADR-002's <5ms P99
gate under realistic fleet size, revisit inlining it into
`enqueue_fsm_dispatch_v2` for the near-zero-latency path, on top of (not instead
of) the `pg_cron` sweep as a safety net for entries that couldn't be scheduled
immediately.

Option A (status quo) is superseded by this decision once Option C ships.

## Consequences & migration

- **Harder:** Debugging shifts from live process logs to `cron.job_run_details`
  queries; anyone used to `docker logs fsmscheduler` / Pino output needs a new
  habit. Running multiple scheduler instances for future throughput sharding
  (ADR-002's noted possible future need) is no longer straightforward with a
  single `pg_cron` job — would need multiple jobs partitioned by FSM type if
  that need materializes.
- **Easier:** One fewer process to deploy, restart, and health-check on the
  control plane. Changing the poll interval or stale threshold becomes a SQL
  `cron.alter_job` call instead of a redeploy with new CLI flags.
- **Migration:** originally planned as a big-bang cutover (steps 1-5 below);
  **step 3 (deleting `fsmscheduler.ts`) is deferred** per implementation
  decision — see the note after step 5.
  1. Add `fsm_core.schedule_all_pending(stale_threshold_seconds int)` wrapper
     function + pgTAP tests.
  2. Register the `pg_cron` job calling it on the agreed interval.
  3. ~~Remove `packages/fsm-sync-worker-ts/src/fsmscheduler/` and
     `packages/fsm-sync-worker-ts/src/cli/fsmscheduler.ts`, and any process
     supervisor / deployment entry that starts them.~~ **Deferred** —
     `fsmscheduler.ts` stays running as a fallback safety net alongside the
     `pg_cron` drain; its 30s poll loop calls `schedule_next_pending()`
     independently of `pg_notify`, which is safe to run concurrently
     (`SELECT FOR UPDATE SKIP LOCKED`). Deletion becomes a separate future
     decision once the `pg_cron` drain has run in production long enough to
     trust as the sole mechanism.
  4. Remove the `pg_notify('fsm_scheduler_work', ...)` call from
     `enqueue_fsm_dispatch_v2` (redundant now that `pg_cron` drains — but
     `fsmscheduler.ts`'s `LISTEN "fsm_scheduler_work"` remains in the code, now
     permanently dormant since nothing notifies it, rather than removed).
  5. Update ADR-002 (mark the "eliminate fsmscheduler" TODO resolved, link this
     spec) and ADR-003 (describe `pg_cron` as the primary scheduling path and
     `fsmscheduler` as a fallback-only holdover, not removed as originally
     planned).
- **Rollback:** with step 3 deferred, `fsmscheduler.ts` never leaves the
  codebase, so rollback only concerns the `pg_notify` removal (step 4) and the
  new `pg_cron` job/function (steps 1-2) — `git revert` those PRs and disable
  the `pg_cron` job; `fsmscheduler.ts` picks the notify path back up unchanged.
  No data migration involved since `fsm_dispatch_queue` and `fsm_daemon_node`
  schemas don't change.

## Acceptance criteria

- [ ] `fsm_core.schedule_all_pending(stale_threshold_seconds int)` exists, loops
      `schedule_next_pending()` until it returns `false`, and has pgTAP coverage
      alongside the existing `20250119124737_fsm_schedule_next_pending.sql`
      tests.
- [ ] Installed `pg_cron` version and sub-minute (`'N seconds'`) schedule syntax
      support is verified before implementation; actual chosen interval is
      documented (target: 5–10s, falling back to 1 minute if sub-minute syntax
      isn't available).
- [ ] A `pg_cron` job is registered calling `schedule_all_pending()` on that
      interval, configurable via `cron.alter_job` without a code deploy.
- [x] ~~`packages/fsm-sync-worker-ts/src/fsmscheduler/` and
      `packages/fsm-sync-worker-ts/src/cli/fsmscheduler.ts` are deleted, along
      with any deployment/process-supervisor config that referenced them.~~
      **Deferred, not required for acceptance** — `fsmscheduler.ts` stays as a
      fallback safety net; see Consequences & migration.
- [ ] The `pg_notify('fsm_scheduler_work', ...)` call is removed from
      `enqueue_fsm_dispatch_v2`. `fsmscheduler.ts`'s LISTEN on that channel
      remains in the code but is confirmed dormant, since nothing calls
      `pg_notify` on it anymore.
- [ ] End-to-end: enqueueing a dispatch entry results in it being scheduled to a
      capable fsmlet within the documented interval, verified against a running
      local Supabase instance with `pg_cron` enabled.
- [ ] Existing dispatch correctness behavior is unchanged: stale-fsmlet
      filtering, capacity scoring, and `SKIP LOCKED` safety all still pass their
      current pgTAP tests unmodified (aside from the new wrapper).
- [ ] `cron.job_run_details` (or an equivalent) is confirmed to surface job
      failures somewhere ops-visible; if full alerting integration is out of
      scope for this pass, that gap is explicitly documented rather than
      silently dropped.
- [ ] ADR-002's "Explore eliminating the application-level fsmscheduler" TODO is
      updated to reference this spec as its resolution.
- [ ] ADR-003's architecture diagram and connection accounting section are
      updated to describe `pg_cron` as the primary scheduling path and
      `fsmscheduler` as a fallback-only holdover (not removed).

## Implementation

- #142 — add `schedule_all_pending()`, register the `pg_cron` job, verify
  end-to-end (spec steps 1-2)
- #143 — remove the `pg_notify('fsm_scheduler_work', ...)` call, update
  ADR-002/ADR-003 (spec steps 4-5; step 3, deleting `fsmscheduler.ts`, is
  deferred — see Consequences & migration)
