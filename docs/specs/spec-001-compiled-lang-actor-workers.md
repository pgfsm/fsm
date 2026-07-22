# SPEC-001: Polyglot Actor Workers for Compiled Languages via Local IPC

| Field   | Value                                                                                     |
| ------- | ----------------------------------------------------------------------------------------- |
| Status  | Draft                                                                                     |
| Date    | 2026-07-22                                                                                |
| Authors | Niraj, Claude                                                                             |
| Issue   | #55                                                                                       |
| Affects | `apps/fsm-core-worker-ts`, `packages/fsm-compiler-ts`, `apps/fsm-core-example`, `docs/kb` |

---

## Problem

`asyncOperationWorkerlet.ts`'s `startPromiseWorkerForLang` (line ~92) dispatches
a claimed promise-actor invocation by `fsmLanguage`:

- `"typescript"` — in-process, dynamic `import()`, polls PGMQ itself
  (`startFSMPromiseWorker`).
- `"python"` — spawns `fsmpromiseworker.py` as a subprocess, but that subprocess
  _also_ opens its own `psycopg2` connection and runs its own independent poll →
  invoke → archive loop.
- `"go"` / `"rust"` — logs
  `"Promise worker for lang={lang} not yet
  implemented"` and returns. **No
  worker runs at all.**

The go/rust gap isn't a small wiring fix:
`validateAsyncOperationFromFoldersV2`'s checkers for these languages
(`check_fn.go`, `check_fn.rs`) only do a **static syntax check** (AST scan for
Go, substring match for Rust) — there is no existing mechanism to dynamically
invoke a compiled Go or Rust function the way `import()` does for TS or
`importlib` does for Python. An actual invocation path has to be designed, not
patched in.

No specific actor is blocked on this today — this is proactive design work to
close a known, documented gap (the `"not yet implemented"` log line has existed
since the go/rust branches were stubbed) before it becomes a blocker.

## Constraints

From `docs/kb/kb-001-distributed-multilang-fsm.md` (standing architectural
guidance for this exact problem space):

- **Orchestrator vs. activity split**: only the orchestrator tier touches the
  DB/queue; activity workers (actors) should ideally hold **zero** DB
  connections (KB-001 §2, §3.2).
- **Connection minimization**: DB connections must not scale with the number of
  polyglot actor processes (KB-001 §1.4, §3.3). Today's Python path (one
  `psycopg2` connection per active queue) is explicitly KB-001's "option A...
  simplest, but defeats the goal" — an accepted stopgap, not the target state.
- **Polyglot via queue, not via transport rebuild**: KB-001 §3.3 recommends an
  Activity Gateway (option B) or neutral broker (option C) for the general case.
  A full gateway (gRPC/HTTP service, its own deployment, wire contract, SDK) was
  prototyped 2026-06-14 and **reverted 2026-06-23 as "too complex for now"**
  (KB-001 §5, "Reverted work"). Reintroducing that scope is explicitly out of
  bounds for this spec — this design must stay smaller than that reverted
  prototype.
- **Kubelet analogy already established**: `asyncOperationWorkerlet.ts`'s own
  doc comment and ADR-002 (Stage 3, FSM-instance side) both use the Kubernetes
  kubelet/scheduler framing. This spec keeps that framing rather than
  introducing a new mental model.

Additional constraints surfaced during interrogation:

- **No confirmed container runtime** in the deploy target. The design must not
  require Docker/Podman; a plain compiled-binary subprocess is the default.
- **No live Go/Rust actor exists yet** — acceptance is proven with a reference
  fixture, not a production migration.
- **WASM-in-Deno ruled out explicitly**: compiling actors to WASM and running
  them in-process (like TS's `import()`) was considered and rejected — real
  actor business logic needs full OS access (outbound network calls, file I/O,
  native libs), which WASM sandboxing would block. Not revisited in this spec.

## Options considered

### Option A — Direct-connection worker per language (extend today's Python model to Rust)

A Rust subprocess owns its own DB connection, polls PGMQ directly, calls the
actor function in-process, and archives the result — mirroring
`fsmpromiseworker.py` exactly.

- **Pros**: zero new design; precedent already exists and works in production
  for Python.
- **Cons**: adds one DB connection per active queue, directly violating KB-001's
  connection-minimization goal; duplicates the full poll/archive/error handling
  logic per language with no shared harness — every future compiled language
  repeats all of it from scratch.

### Option B — Revive the full Activity Gateway (gRPC/HTTP service)

Rebuild the reverted 2026-06-14 prototype: a standalone gateway service owning
the only DB pool, polyglot workers talking to it over gRPC/HTTP holding zero DB
connections.

- **Pros**: general solution for _any_ number of languages/processes; closest to
  KB-001's fully-realized recommendation.
- **Cons**: this is the scope that was already tried and explicitly reverted as
  too complex; it adds a new network service to deploy, secure, and monitor, for
  a need that currently has no live actor driving it. Disproportionate to the
  problem size today.

### Option C — Orchestrator-held poll + warm per-queue subprocess + Unix domain socket IPC (chosen)

The TS orchestrator (`asyncOperationWorkerlet.ts`) keeps 100% of PGMQ
poll/claim/archive logic — nothing moves out of it. For `"rust"` (and later
`"go"`), `startPromiseWorkerForLang` launches one warm subprocess per active
queue (`Deno.Command`, no container), tracked in `activeWorkers` and killed via
the existing `AbortController`/signal pattern — the same lifecycle shape
Python's subprocess already uses today. Instead of the subprocess polling PGMQ
itself, the orchestrator sends it one request at a time over a **Unix domain
socket** and awaits the response; the subprocess never opens a DB connection.

A single generic "poll + dispatch-over-socket" harness is written once in TS and
reused for every compiled language; each language only needs a small shim that
accepts one connection, reads one framed request, calls the named function,
writes one framed response, and loops.

- **Pros**: zero DB connections in the polyglot worker (satisfies KB-001's
  actual goal without the gateway's deployment surface); one harness reused
  across languages instead of a bespoke poller per language; no container
  runtime dependency; socket transport avoids the risk of an actor's own
  `println!`/log output corrupting a shared-stdio protocol (a real risk with
  stdin/stdout framing, since the actor's own dependencies may write to stdout
  unpredictably); rollback is trivial (revert to the no-op branch, zero blast
  radius on TS/Python).
- **Cons**: one request in flight per process at a time (matches today's
  single-consumer-per-queue model everywhere else, so not currently a real
  limitation); introduces a new small protocol/contract to maintain as more
  languages are added; adds one indirection hop for debugging (TS ↔ socket ↔
  compiled process) versus in-process TS.

### Option D — Do nothing (smaller hammer): leave go/rust unimplemented until an actor needs it

- **Pros**: zero effort now; avoids speculative complexity for a need with no
  current live driver.
- **Cons**: the gap is already documented and known; deferring means the first
  real Go/Rust actor request becomes blocked on this design work landing on the
  critical path, instead of already being solved infrastructure.

## Decision

**Option C.** It is the smallest design that actually satisfies KB-001's
connection-minimization and orchestrator/activity-split goals, without
re-entering the scope that got the Activity Gateway reverted. Decision drivers,
in order:

1. **Zero DB connections on the polyglot side** — the one property Option A
   fails and Option C achieves without Option B's cost.
2. **Reuse over rebuild** — Option C reuses existing lifecycle machinery
   (`activeWorkers`, `AbortController`, the lazy-compile-and-cache pattern
   already used for `check_fn.go`/`check_fn.rs`) rather than introducing a new
   service class.
3. **No new infra requirement** — ruled out containers (unconfirmed runtime) and
   ruled out a gateway service (new deployable) in favor of a subprocess +
   socket, both of which are things this codebase already does today (Python
   subprocess, LISTEN-based sockets from Postgres).
4. **Protocol robustness** — Unix domain socket over stdin/stdout specifically
   to avoid a corrupted-framing failure mode where the actor's own output
   pollutes the RPC channel.

**First reference implementation targets Rust.** Go follows later against the
same contract (reusing `check_fn.go`'s existing AST-based validation approach
for its own checker); the contract is written generically enough that adding Go
should not require renegotiating the protocol.

## Consequences & migration

- **No migration required.** Go/Rust have zero workers today — this is net-new
  capability. TS and Python branches of `startPromiseWorkerForLang` are
  untouched.
- **What gets harder**: one more artifact type to build/ship per compiled
  language (a shim binary conforming to the socket contract); one more contract
  to keep stable as languages are added; debugging a Rust actor invocation now
  involves a socket hop instead of a single in-process call.
- **Rollback story**: the new code path is fully gated on
  `fsmLanguage ===
  "rust"` (soon `"go"`) inside `startPromiseWorkerForLang`.
  Reverting means restoring the no-op/log-warning branch — no impact on TS or
  Python actors, no schema or data migration to undo.
- **Explicitly deferred, not solved by this spec**: per-actor dependency
  isolation (e.g. two Rust actors needing incompatible native library versions)
  — this would need containers or per-actor build isolation, which is out of
  scope given the "no confirmed container runtime" constraint. If that need
  arises, containerizing the same socket-shim subprocess is a compatible future
  upgrade, not a redesign.

## Acceptance criteria

- [ ] A language-neutral shim contract is documented: request/response JSON
      shape, socket framing (e.g. length-prefixed or newline-delimited over the
      Unix socket), startup handshake, one-request-at-a-time semantics, and
      graceful-shutdown signal — reusing the activity contract shape already
      defined in KB-001 §3.2
      (`{actor, version, input, instance_id,
      correlation_id}` →
      `{output | error}`) rather than inventing a new shape.
- [ ] `startPromiseWorkerForLang`'s `"rust"` branch launches a warm subprocess
      per active queue via `Deno.Command` (no container), tracked in
      `activeWorkers` and terminated via the existing
      `signal.addEventListener("abort", ...)` pattern already used for Python.
- [ ] The TS orchestrator retains sole ownership of `readMessage` (PGMQ poll)
      and `archiveEventFromFsmPromiseTypeWorker` (archive) — the Rust subprocess
      never opens a DB connection, verified by inspection/log audit of the
      reference implementation.
- [ ] A reference Rust actor + shim exists (fixture under
      `apps/fsm-core-example/` or a test-only fixture) proving the full path
      end-to-end: dispatch → claim → orchestrator forwards over the Unix socket
      → Rust shim executes the actor function → response returned → archived.
- [ ] `validateAsyncOperationFromFoldersV2`'s Rust checker (`check_fn.rs`)
      either continues to pass unmodified, or is extended — decided and
      documented in the implementation issue — if the shim contract requires
      confirming more than "a function with this name exists" (e.g. a specific
      entrypoint that speaks the socket protocol).
- [ ] Failure modes are handled and covered by the reference implementation:
      subprocess crash mid-request (orchestrator does not hang indefinitely —
      timeout/abort path required), socket connect failure at startup (surfaced
      as a warning; queue not marked active, matching today's `pgmqQueueExists`
      guard behavior), and clean shutdown drains without leaving orphaned
      sockets or zombie processes.
- [ ] Go is explicitly out of scope for the first implementation, but the shim
      contract is validated as polyglot-ready (not Rust-specific) before
      merging, so a Go shim can follow later without a protocol renegotiation.

## Implementation

<!-- Filled in after acceptance: links to implementation issues and PRs. -->
