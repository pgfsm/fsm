# SPEC-008: Async Actor Coverage and Liveness

| Field   | Value                                                                                                                                                                                               |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status  | Draft                                                                                                                                                                                               |
| Date    | 2026-09-29                                                                                                                                                                                          |
| Authors | Niraj, Claude (Opus 5.5)                                                                                                                                                                            |
| Issue   | #419                                                                                                                                                                                                |
| Affects | `packages/fsm-cli-ts`, `packages/fsm-compiler-ts`, `packages/fsm-async-worker-gateway-ts`, `packages/fsm-ctl-ts`, `packages/fsm-core-db-ts`, `packages/database-src`, `packages/fsm-sync-worker-ts` |

Related: SPEC-006 (#418, fsmlet definition check), SPEC-007 (#394, gateway TCP
and independent scaling).

---

## Problem

One `fsm.json` declares async actors in several languages
(`asyncOperationLanguage`), and each is served by a separate worker process
through the Activity Gateway. Today nobody can answer "are this FSM's async
actors implemented, and is anything serving them right now?":

1. **Generated code can go stale.** The compiler scaffolds a stub and a registry
   entry for every actor in its declared language, so a _missing_ file breaks
   the build. But edit `fsm.json` (add an actor, change its language or version)
   without regenerating, and the language registries and `actors-manifest.json`
   silently disagree with the definition. Nothing compares them.
2. **Placeholder stubs look like success.** Scaffolded stubs return dummy data
   (`// TODO: implement actor logic`, e.g.
   `test-apps/debug-only/async-worker/typescript/creditCheck/v01/actors/determineMiddleScore/determineMiddleScore.ts`).
   An unimplemented actor completes the invoke "successfully", and the FSM moves
   on with fake output.
3. **An unserved actor is silent.** Each actor identity has its own PGMQ queue
   (`compute_async_operation_queue_name_v2`), created on first invoke
   (`archive_from_fsm_instance_worker_v2.sql`). The gateway only claims for
   actors that have a registered worker. If a language's workers aren't deployed
   or have crashed, messages pile up in that queue and the instance waits in its
   invoking state indefinitely, with no error and no alert.
4. **Worker state is invisible outside the gateway process.** Actor → worker
   routing lives in memory in `SidecarGateway`. With several gateway replicas
   (SPEC-007), no single place knows which actors have live workers. The v1
   registry checks (`checkRegistryForAsyncActors` /
   `checkRegistryAndWorkingForAsyncActors`) read v1 tables that the gateway
   doesn't maintain.

SPEC-006 deliberately kept async actors out of the fsmlet's fail-fast check:
they come and go at runtime, so a startup gate is the wrong tool. This spec
supplies the right tools instead: a build-time check for 1–2, and a runtime view
plus alerting for 3–4.

## Constraints

- **ADR-003: polyglot via queue.** Async actors are decoupled from the FSM by a
  durable queue, so their absence must never block the sync fleet. Every runtime
  signal here is **observational, never a gate**.
- **Connection minimization** (root `CLAUDE.md` #4). Gateways publish state
  through their existing pool, with one write per replica per interval, not per
  worker or per actor. Readers (pgfsmctl, the fsmlet) use one query.
- **SPEC-007 (gateway as a Deployment).** Gateways are N replicas, each knowing
  only its own workers. SPEC-007 has been asked (review comment on #394) to
  require a per-replica snapshot of actor key → live workers, Σ
  `max_concurrency`, in-flight. This spec aggregates those snapshots. Without
  SPEC-007's `max_concurrency`, a worker counts as capacity 1 (SPEC-007's
  `0 ⇒ 1` rule).
- **Scaffolded stubs are user-owned.** `--overwrite generated-only` never
  rewrites them, so any marker only reaches new stubs. Existing ones need a
  fallback rule.
- **Generated code goes through Eta templates** with do-not-edit headers.
- **SPEC-005 boundaries.** Project-aware commands go in `@pgfsm/cli` (`pgfsm`).
  Database-only ops commands go in `@pgfsm/ctl` (`pgfsmctl`).
- **Schema changes follow `docs/schema-change-propagation.md`.**

## Options considered

### Coverage (problems 1–2)

| Option                                                                     | Verdict                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1: do nothing                                                             | Rejected. Stale registries and fake actor output reach production unnoticed.                                                                                                                                                                     |
| **A2: `pgfsm check`: regenerate in memory, diff, scan stubs for a marker** | **Chosen.** Project-aware, CI-friendly, one command covering every language.                                                                                                                                                                     |
| A3: compiler `--check` dry-run flag                                        | Rejected. The compiler works per FSM folder and per command, so the user would chain several invocations across languages. `pgfsm` already knows the project layout.                                                                             |
| A4: stubs throw `NotImplemented` by default                                | Rejected for this spec. It fails loudly at runtime, but it breaks the "scaffold and run end to end immediately" flow that `pgfsm create` and `test-apps/debug-only` rely on. The marker plus `pgfsm check` catches the same thing before deploy. |

### Aggregating live worker state across gateway replicas (problems 3–4)

| Option                                                        | Verdict                                                                                                                                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **B1: Postgres heartbeat table, one row per gateway replica** | **Chosen.** Same pattern as `fsm_workerlet`. Every reader already has DB access and none needs network reach to gateways. It aggregates across replicas with one query. Stale replicas age out by timestamp. |
| B2: pgfsmctl queries each gateway (admin RPC)                 | Rejected. It needs replica discovery, TLS and token distribution to every reader, and network reachability from wherever `pgfsmctl` runs. The fsmlet would need gateway credentials.                         |
| B3: Prometheus `/metrics` per gateway                         | Rejected as the primary mechanism. It makes Prometheus a hard dependency for any status view, and the fsmlet and `pgfsmctl` can't read it. It remains a reasonable later addition on top of B1.              |

### Alerting (problem 3)

| Option                                                                             | Verdict                                                                                                                                                     |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1: SQL status function + `pgfsmctl actors status` with a meaningful exit code** | **Chosen.** Works from any cron, Kubernetes CronJob or monitor. Distinguishes "no worker" from "slow worker" by joining queue age with the heartbeat table. |
| C2: C1 plus a Prometheus exporter                                                  | Deferred. It can be layered on C1's function later without design changes.                                                                                  |

## Decision

A2 + B1 + C1, plus a non-fatal fsmlet warning. The deciding drivers:

1. **Catch what can be caught before deploy.** Staleness and placeholders are
   static facts about the project, so they belong in CI (`pgfsm check`), not at
   runtime.
2. **Runtime signals must not gate** (ADR-003). A heartbeat table plus a status
   function is observational by construction. Readers decide what to do with it.
3. **One place to ask, reachable by every reader.** Postgres is the only
   component that every gateway, the fsmlet and `pgfsmctl` can already reach,
   with credentials they already have.

### D1 — Placeholder marker in stub templates (`@pgfsm/compiler`)

- Each language's actor stub template emits a stable marker comment next to the
  existing TODO: `pgfsm:placeholder-stub` in that language's comment syntax
  (`//` for TS/Rust/Go, `#` for Python). Implementers delete the line when they
  write the actor.
- Stubs keep their current dummy return (A4 rejected).
- **Legacy rule:** stubs scaffolded before this spec lack the marker. The check
  also treats an actor file as a placeholder if it still contains the exact
  scaffold text `TODO: implement actor logic`.

### D2 — `pgfsm check` (`@pgfsm/cli`)

`pgfsm check [--allow-placeholders] [--json]`, run from within a pgfsm project:

1. **Staleness.** For every FSM version under `fsm/`, run the same generation
   `pgfsm add --force` would, into memory, for **generated-only** files: sync
   registries, per-language actor registries, `actors-manifest.json`, and the
   aggregates. Diff the result against disk. Any difference is reported per
   file, with the command that regenerates it.
2. **Coverage.** Every async actor in each `fsm.json` resolves to an entry in
   its `asyncOperationLanguage`'s manifest, with its implementation file
   present. Step 1 mostly covers this, but it gets a dedicated, actor-named
   message
   (`creditCheck/v01 actor checkBureauRust (rust): not in rust manifest`).
3. **Placeholders.** Every actor implementation file matching D1's marker or
   legacy rule is listed as `placeholder`.
4. **Exit code:** non-zero if anything in 1 or 2 fails, or if any placeholder
   exists, unless `--allow-placeholders` is passed (for local development).
   `--json` emits the same findings as machine-readable output for CI
   annotations.

`pgfsm check` needs no database and doesn't read any other pgfsm project.

### D3 — Gateway heartbeat table (`database-src`, `@pgfsm/async-worker-gateway`)

- New table `fsm_core.async_operation_gateway_heartbeat`, one row per gateway
  replica:
  - `gateway_id uuid primary key`
  - `gateway_pid text` (host/pod name)
  - `actors jsonb`: one element per actor key served by this replica, with the
    6-field identity (`parent_fsm_name`, `parent_fsm_version`,
    `async_operation_type`, `async_operation_name`, `async_operation_version`,
    `async_operation_language`), plus `queue_name`, `worker_count`,
    `max_concurrency_sum` and `in_flight`
  - `started_at timestamptz`
  - `last_heartbeat timestamptz`
- The gateway upserts its row through its existing pool, every
  `--heartbeat-interval-ms` (default 5 s), from the per-replica snapshot
  SPEC-007 requires. It's one statement per interval regardless of worker or
  actor count. On graceful stop it deletes its row.
- A row is **live** while `last_heartbeat > now() - 3 × interval`. Rows older
  than 10 minutes are deleted by the status function's caller path (D4), so
  crashed replicas don't accumulate.
- The v1 tables and the `checkRegistry*` helpers are untouched. They're
  deprecated with the v1 async worker and are not reused.

### D4 — Actor status function (`database-src` + `@pgfsm/db`)

`fsm_core.async_operation_actor_status_v2(input_max_age_seconds int)` returns
one row per actor identity:

- **Actor universe:** the union of
  - actors declared in loaded definitions: async invokes found in
    `fsm_core.fsm_json` via `jsonb_path_query`, with the queue name computed by
    `compute_async_operation_queue_name_v2`;
  - actors in any live heartbeat row.
- **Columns:** the identity, `queue_name`, `live_workers` (Σ `worker_count` over
  live rows), `capacity` (Σ `max_concurrency_sum`), `in_flight`, `queue_length`
  and `oldest_msg_age_sec` (from `pgmq.metrics`, or 0 when the queue doesn't
  exist yet), and `status`:
  - `no_worker`: `queue_length > 0` and `live_workers = 0`. Work is waiting and
    nothing can take it. This is the alert.
  - `backlogged`: `live_workers > 0` and
    `oldest_msg_age_sec > input_max_age_seconds`. Work is waiting too long.
  - `unserved`: `queue_length = 0` and `live_workers = 0`. Declared but not
    running, with nothing waiting (informational).
  - `ok`: everything else.
- It is one read-only statement, plus the stale-row cleanup from D3. `@pgfsm/db`
  wraps it as `asyncOperationActorStatus(deps, maxAgeSeconds)`, following the
  PG→TS naming rules.

### D5 — `pgfsmctl actors status` (`@pgfsm/ctl`)

`pgfsmctl actors status [--max-age <seconds, default 60>] [--fsm <name>[/<version>]] [--json] [--db-url]`:

- Prints one row per actor: identity, status, workers, capacity, in-flight,
  queue length, oldest age.
- **Exit code:** `0` when every actor is `ok` or `unserved`, and `2` when any is
  `no_worker` or `backlogged`. So `pgfsmctl actors status` in a cron or
  Kubernetes CronJob _is_ the stuck-queue alert, with no extra infrastructure.
  Other failures (DB unreachable) exit `1`.

### D6 — fsmlet startup warning (`@pgfsm/sync-worker`)

- After SPEC-006's definition check passes, `startFsmlet` calls
  `asyncOperationActorStatus` once and filters it to actors declared in the
  definitions it serves.
- It logs **one warning** listing actors whose status is `no_worker` or
  `unserved` (for example
  `creditCheck/v01 checkBureauRust (rust): no live
  worker`).
- It **never** throws, and it never delays registration beyond that one query. A
  query failure is itself logged as a warning.
- `FsmletOptions.warnOnUnservedAsyncActors?: boolean` (default `true`) turns the
  warning off. `skipFsmDefinitionCheck` (SPEC-006) also skips it.
- It runs at startup only. Continuous detection is D5's job.

## Consequences & migration

**What gets harder**

- **Placeholder stubs fail CI by default.** Projects in active scaffolding must
  pass `--allow-placeholders`, or finish their actors, before `pgfsm check`
  passes. That's intended, but new users will hit it.
- **The marker is honor-system.** Deleting the marker line without implementing
  the actor defeats the check. It catches forgetting, not intent. (A4 remains
  the stronger option if this proves too weak.)
- **Gateways gain a periodic write.** One upsert per replica every 5 s is
  negligible, but it's new DB traffic from the activity tier.
- **The status function scans loaded `fsm_json` definitions.** That's fine at
  current definition counts. If it grows, cache the declared-actor set in a
  table populated at load time (`pgfsmctl fsm load`, SPEC-006).

**Migration**

1. `database-src` + `@pgfsm/db`: heartbeat table, status function, TS wrappers
   (schema-change propagation doc).
2. `@pgfsm/async-worker-gateway`: publish heartbeats. This is independent of
   SPEC-007: a single-replica gateway today works the same, with capacity
   counted as 1 per worker until SPEC-007 adds `max_concurrency`.
3. `@pgfsm/ctl`: `actors status`.
4. `@pgfsm/compiler`: marker in the four stub templates.
5. `@pgfsm/cli`: `pgfsm check`. Regenerate `test-apps/debug-only`, whose
   placeholder stubs will then be reported, as expected for a debug project; its
   README documents `--allow-placeholders`.
6. `@pgfsm/sync-worker`: the startup warning (after SPEC-006 lands).

**Rollback**

- Every piece is additive and observational:
  - `pgfsm check` is opt-in per CI pipeline.
  - The fsmlet warning is off with `warnOnUnservedAsyncActors: false`.
  - Gateway heartbeats can be disabled with `--heartbeat-interval-ms 0`.
- The table and function come out with an ordinary down-migration. Nothing in
  the dispatch path reads them.

## Acceptance criteria

- [ ] New actor stubs in TS, Python, Rust and Go contain
      `pgfsm:placeholder-stub` and keep their current dummy return.
- [ ] `pgfsm check` reports a stale file, and exits non-zero, when `fsm.json`
      has changed without regeneration (for example, an actor's
      `asyncOperationLanguage` changed).
- [ ] `pgfsm check` names each actor in `fsm.json` that is missing from its
      language's manifest.
- [ ] `pgfsm check` lists every actor file that has the marker, or the legacy
      `TODO: implement actor logic` text, and exits non-zero unless
      `--allow-placeholders` is passed.
- [ ] `pgfsm check` on a freshly regenerated project with all actors implemented
      exits 0 and needs no database.
- [ ] With two gateway replicas serving the same actor, `pgfsmctl actors status`
      shows `live_workers` equal to the sum across both replicas.
- [ ] Killing a gateway replica (no graceful stop) drops its workers from the
      status within 3 heartbeat intervals. Its row is removed after 10 minutes.
- [ ] A graceful gateway stop deletes its heartbeat row.
- [ ] With messages in an actor's queue and no live worker for it,
      `pgfsmctl actors status` reports `no_worker` and exits 2.
- [ ] With live workers and an oldest message older than `--max-age`, the status
      is `backlogged` and the exit code is 2.
- [ ] An actor declared in a loaded definition that has no worker and no queued
      messages reports `unserved` and exit 0.
- [ ] The gateway's heartbeat is one statement per interval per replica,
      whatever the worker and actor counts, on its existing pool.
- [ ] `startFsmlet` logs one warning naming each served async actor with no live
      worker, and still registers and runs normally. A failure of the status
      query is logged, not thrown.
- [ ] `warnOnUnservedAsyncActors: false` suppresses that warning.
- [ ] Nothing in the dispatch or claim path reads
      `async_operation_gateway_heartbeat` or the status function.

## Implementation

<!-- Filled in after acceptance: links to implementation issues and PRs. -->
