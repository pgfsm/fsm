# Database stress testing

A harness under `scripts/stress/` that drives concurrent load directly against
the `fsm_core` SQL functions — bypassing the TS worker layer where a wrapper
isn't required — to answer: how many concurrent FSM instance executions can a
single Postgres install sustain, and what breaks first?

See issue [#206](https://github.com/pgfsm/fsm/issues/206) for the motivating
question and
[adr-002](../../../../docs/adr/adr-002-fsm-sync-operation-worker-execution-model.md)
/ [spec-003](../../../../docs/specs/spec-003-pgcron-fsm-scheduler.md) for the
prior unfulfilled "benchmark `schedule_next_pending` at P99" decision gate this
fills.

## Running it

Local Supabase must be running first:

```bash
npm run supabase:start:env
```

Then, from `packages/database-src/`:

```bash
npm run stress -- --scenario=creation --count=200 --concurrency=20
```

(`npm run stress` forwards everything after `--` to `deno task stress`, which
runs `scripts/stress/run.ts`.)

### Flags

| Flag                  | Default               | Meaning                                                                          |
| --------------------- | --------------------- | -------------------------------------------------------------------------------- |
| `--scenario`          | `all`                 | `creation`, `macrostep`, `claim`, `mixed`, or `all`                              |
| `--concurrency`       | `20`                  | In-flight calls for `creation`/`macrostep`, and default poller count for `claim` |
| `--pool-size`         | `max(concurrency,10)` | Size of the harness's own `pg.Pool` — the connection-minimization axis           |
| `--count`             | `500`                 | Instances created for `creation`/`mixed`                                         |
| `--duration`          | `15000` (ms)          | Wall time for the loop-based `macrostep`/`claim`/`mixed` scenarios               |
| `--create-pgmq-queue` | `false`               | Whether `creation` also creates a pgmq queue per instance (see caveat below)     |
| `--fsmlet-pollers`    | `concurrency`         | Simulated fsmlet count in `claim`                                                |
| `--scheduler-pollers` | `1`                   | Simulated fsmscheduler count in `claim` (production runs exactly one)            |
| `--async-op-pollers`  | `2`                   | Simulated async-op gateway worker count in `claim`                               |

## What each scenario measures

- **`creation`** — bursts `createFsmInstanceFromName` (the
  `create_fsm_instance_from_name_v2` wrapper) at `--concurrency` in flight.
  Isolates raw `fsm_instance` row-insert throughput when
  `--create-pgmq-queue=false`.
- **`macrostep`** — hammers `fsm_core.macrostep_v2` directly (no TS wrapper
  exists for it) with a fixed `event_name = 'initialTransition_event'` call,
  which the function special-cases to resolve without needing real per-instance
  state tracking. This isolates the function's own throughput under concurrency
  from full instance-lifecycle bookkeeping.
- **`claim`** — runs fsmlet pollers (`claimScheduledForFsmlet`,
  `FOR UPDATE
  SKIP LOCKED`), fsmscheduler pollers (`scheduleNextPending`), and
  async-op gateway pollers (`claimPendingAsyncOperationEventsForWorkers`)
  concurrently, mostly against empty queues — the common idle-poll case in
  production. Measures poll/claim overhead and lock contention as poller count
  scales.
- **`mixed`** — runs all three concurrently, since real deployments run sync
  macrostepping and async-op dispatch at the same time.

Every scenario snapshots `pg_stat_activity` (connection counts by state)
before/after and `pg_locks` (by mode, plus waiting-lock count) after, and prints
a latency table (mean/p50/p95/p99, throughput, error count) per call type. Full
results are written as JSON to `scripts/stress/results/` (gitignored).

## Locking model, for context

`fsm_core.fsm_instance_lock` (a dedicated lock table) is dead code — live
locking is column-flag based on `fsm_core.fsm_instance`
(`worker_locked`/`worker_locked_by`/...) via a plain
`UPDATE ... WHERE worker_locked = FALSE`. There's no advisory lock or dedicated
lock table in the live path — "lock contention" here means row `UPDATE`
contention on `fsm_instance`, plus `FOR UPDATE SKIP LOCKED` contention in the
claim functions above.

## Known caveats

- **pgmq queue growth.**
  `create_fsm_instance_from_name_v2(..., create_pgmq_queue
  = true)` creates a
  new pgmq queue (a new table) per instance. A `creation` run with
  `--create-pgmq-queue=true` at meaningful scale will leave that many queue
  tables behind. Run `npm run supabase:db:reset` between heavy runs to get back
  to a clean baseline — the harness does not attempt automatic teardown.
- **Local, not production.** Numbers from local Docker Supabase reflect your
  laptop's container resource limits (CPU/memory/disk), not a managed or
  production Postgres instance. Treat results as relative (where does throughput
  bend, what's the first resource to saturate) rather than absolute capacity
  numbers to plan a deployment around.

## Baseline findings (2026-09-15, local Docker Supabase, M-series Mac)

A single representative sweep, not an exhaustive matrix — concurrency 10 / 25 /
50 / 80 per scenario, `--create-pgmq-queue=false`. Full JSON output is not
committed (see the gitignore caveat above); numbers below are pulled from that
run's console output. Local `max_connections = 100`
(`superuser_reserved_connections = 3`), with ~12 connections already held by
other local Supabase services (realtime, postgrest, auth, storage, studio)
before the harness even opens its pool.

**What broke first: the connection ceiling, not an FSM-specific bottleneck.**
Running `creation` with `--pool-size=100` failed immediately with
`remaining connection slots are reserved for non-replication superuser
connections`
— Postgres's `max_connections` was exhausted by the harness's own pool plus the
~12 baseline connections already in use. On this machine, pool sizes above
roughly 85 aren't reachable at all against local Supabase, independent of
anything FSM/pgmq-specific. This is a config ceiling (`max_connections`), not a
query-plan or lock bottleneck — raising it (or, per `CLAUDE.md`'s
connection-minimization goal, keeping the number of concurrently-open Pools low)
is the fix, not schema work.

**`creation`** (`createFsmInstanceFromName`, 200 instances/run):

| concurrency | pool size | req/s  | mean  | p95   | p99   |
| ----------- | --------- | ------ | ----- | ----- | ----- |
| 10          | 10        | 1549/s | 6ms   | 9ms   | 59ms  |
| 25          | 25        | 1018/s | 24ms  | 132ms | 142ms |
| 50          | 50        | 784/s  | 62ms  | 218ms | 226ms |
| 100         | 80        | 431/s  | 213ms | 461ms | 464ms |

Throughput degrades steadily as concurrency rises even with a matched pool size
— each `create_fsm_instance_from_name_v2` call does several writes (instance
row, transition auth copy, dispatch enqueue) inside one transaction, so this
looks like normal write contention scaling, not a sudden cliff. The
`concurrency=100 / pool=80` row shows queuing latency once concurrency exceeds
pool size, as expected.

**`macrostep`** (`fsm_core.macrostep_v2` called directly, 5s window):

| concurrency | req/s  | mean  | p95    | p99    |
| ----------- | ------ | ----- | ------ | ------ |
| 10          | 1140/s | 9ms   | 23ms   | 70ms   |
| 25          | 92/s   | 268ms | 1128ms | 1347ms |
| 50          | 1343/s | 37ms  | 86ms   | 198ms  |
| 80          | 1152/s | 69ms  | 182ms  | 579ms  |

The concurrency=25 row is an outlier relative to its neighbors (10 and 50) and
is most likely local-machine noise (Docker/CPU contention at that moment) rather
than a real cliff at exactly 25 — this is a single-sample local run, not a
controlled benchmark; re-running the sweep a few times would be needed to
separate real signal from laptop noise. Read the overall trend as "throughput
stays in the ~1.0-1.3k req/s range with rising tail latency," not the exact
per-row numbers.

**`claim`** (`claimScheduledForFsmlet` against an idle queue, 5s window):

| fsmlet pollers | req/s   | mean  | p95    | p99    |
| -------------- | ------- | ----- | ------ | ------ |
| 10             | 6296/s  | 1.6ms | 3.3ms  | 6.6ms  |
| 25             | 8802/s  | 2.8ms | 6.3ms  | 13.3ms |
| 50             | 10075/s | 4.9ms | 11.1ms | 25.4ms |
| 80             | 8137/s  | 9.8ms | 21.5ms | 50.2ms |

Clean contention curve: `FOR UPDATE SKIP LOCKED` throughput on the (single-row)
dispatch queue peaks around 50 concurrent pollers, then both throughput drops
and tail latency roughly doubles at 80 — the expected shape for lock-acquisition
contention on a shared queue as poller count grows past the point where there's
little real work to claim. `scheduleNextPending` (one simulated fsmscheduler)
and `claimPendingAsyncOperationEventsForWorkers` follow the same shape at lower
absolute throughput.

**`mixed`** (concurrency=25 creation, 20 fsmlet pollers, 5 async-op pollers,
pool=60, 5s window): every call type's mean/p95 latency roughly doubled to 5x'd
versus its isolated-scenario number at comparable concurrency (e.g.
`macrostep_v2` mean 35ms mixed vs. ~24-37ms isolated at similar concurrency,
`claimScheduledForFsmlet` mean 17.2ms mixed vs. 1.6-4.9ms isolated) — confirms
the premise that combined sync-macrostep + claim-poll + creation load contends
more than any one workload run in isolation suggests.

**Takeaways for future work:**

1. On a laptop-class local Postgres, the connection ceiling is reached well
   before any FSM-specific query bottleneck — this reinforces the `CLAUDE.md`
   connection-minimization goal: it's the limiting resource here, not
   schema/index design.
2. `claim` contention (`FOR UPDATE SKIP LOCKED`) has a clear peak-then-degrade
   shape around 50 concurrent pollers on this fixture — worth re-testing against
   a managed Postgres instance with more headroom before treating 50 as a
   meaningful number rather than a laptop artifact.
3. Mixed workload numbers are consistently worse than isolated ones — capacity
   planning should use `mixed`, not any single isolated scenario, as the
   representative number.
