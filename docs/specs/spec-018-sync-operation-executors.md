# SPEC-018: Sync Operations Run in Separate Per-Language Executors

| Field   | Value                                                                                                                                                                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status  | Accepted                                                                                                                                                                                                                                                                                                |
| Date    | 2026-11-24, revised 2026-11-26                                                                                                                                                                                                                                                                          |
| Authors | Niraj, Claude                                                                                                                                                                                                                                                                                           |
| Issue   | #734                                                                                                                                                                                                                                                                                                    |
| Affects | new `packages/fsm-engine-ts` and `packages/fsm-sync-worker-gateway-ts`, `packages/fsm-sync-worker-ts`, `packages/fsm-proto-codegen`, `packages/fsm-compiler-ts`, `packages/fsm-cli-ts`, new `packages/fsm-sync-worker-sdk-ts` and `packages/fsm-sync-worker-sdk-python` (`-rust`, `-go` in milestone 2) |

---

> **Revision 2026-11-26 (before acceptance, #745).** Implementing #742 changed
> four things. (1) The in-process fsmlet (`@pgfsm/sync-worker`) stays,
> unchanged: executor mode ships as a separate fsmlet package,
> `@pgfsm/sync-worker-gateway`, so the two can run side by side and be compared.
> There is no clean break. (2) Both run instances through one shared engine
> package, `@pgfsm/fsm-engine` (#748), which calls sync operations through one
> interface instead of looking up handlers. (3) The gateway registers with the
> scheduler at once with no FSM versions and adds or removes each executor's
> versions as it registers or leaves, instead of waiting for every language. (4)
> The protocol section matches the merged proto (#736). Decision, sections 1, 2,
> 4, 5, 6 and 8, Rollout, Consequences, Acceptance criteria and Implementation
> are updated; Open questions is new.

## Problem

Sync operations are the actions, guards, delays and invoke input mappers of an
`fsm.json`. Today only the TypeScript fsmlet can run them, and it runs them
**inside the engine process**: `fsmlet.ts` statically imports the project's
generated `SYNC_OPERATION_REGISTRATIONS`, and `macrostepV2` calls each handler
in-process (`fsmworker-helper.ts`). That causes two problems.

1. **Non-TS sync logic is generated but can't run.** `fsm-compiler-ts` already
   generates sync stubs in `python`, `rust` and `go`
   (`generate-sync-operation-logic.ts`), and `SyncOperationRegistration` carries
   a `syncOperationLanguage`. But no runtime executes a non-TS sync operation,
   so a project that asks for Python sync logic gets files that nothing calls.
   Teams whose business logic lives in Python, Rust or Go have to write every
   `assign`, guard and delay a second time in TypeScript.
2. **Sync operations can't reach non-TS libraries.** A guard that needs a Python
   scoring model, or an action that needs a Rust parser, has no way to call it.
   The only option today is to turn the guard into an invoked actor, which adds
   an extra state and an asynchronous round trip just to make a decision.

There is also an engine-quality problem. Because user code runs inside the
engine, the engine is rebuilt per project: it imports a generated file through a
hardcoded path into `test-apps/debug-only/`. A slow or crashing handler shares
the engine's event loop, and `meta.deps` gives user code the engine's own pg
pool in the middle of a macrostep.

Why now: Activity Gateway, SPEC-007 and the four async-worker SDKs already gave
**actors** a polyglot runtime with generated proto contracts in every language.
Sync operations are the last part of an FSM that is tied to one language.

## Constraints

- **ADR-002 (Stage 3):** the fsmlet is a bounded fleet of node agents, assigned
  dispatch entries by the scheduler (SPEC-003). One fsmlet handles up to
  `maxConcurrency` instances at once, with a per-instance lock held for the
  whole macrostep. This spec does not change the dispatch model.
- **ADR-003 / root `CLAUDE.md` point 4:** pg connections are minimized. A new
  process must not add a pool per pod.
- **Macrostep semantics are XState's** and are fixed by SPEC-010 (internal
  events first), SPEC-011 (discarded macrosteps), SPEC-013 (input computed from
  the context at that point) and SPEC-014 (retry, then `error`). Guards are
  evaluated lazily: from each active leaf, the first candidate whose guard
  passes wins. Actions thread the context one after another.
- **SPEC-006:** the fsmlet refuses to register while any served FSM is missing,
  ambiguous, drifted, undigested or `unimplemented`.
- **SPEC-002:** proto contracts live in `fsm-proto-codegen` and stubs are
  generated for every language with Buf.
- **SPEC-017:** SDKs are Apache-2.0 and must not import engine code. The
  executors live in new per-language sync-worker SDKs.
- **One sync language per FSM version:** all sync operations of one `fsm.json`
  version are in the same language. Different FSMs, and different versions of
  one FSM, may use different languages.

## Options considered

### Option A: native fsmlet per language

Port the engine loop (lock, event read, transition selection, microstep calls,
internal-event queue, archive outcomes, retry policy, definition check,
registration and heartbeat) to Python, Rust and Go, and run sync operations
in-process in each.

- Pro: one process per pod, with no IPC hop. No TS runtime for non-TS users.
- Con: four copies of the most correctness-sensitive code (about 2,250 lines of
  TS in `src/fsmlet/` today, plus the SQL contract). Every engine spec (as
  SPEC-010 to 014 were) must land four times. The copies drift unless there is a
  cross-language conformance suite large enough to cover the whole engine.
- Con: four engine runtimes to release, version and keep compatible with
  `fsm_core`.

### Option B: remote engine tier ("sync gateway")

Workers keep the engine loop but talk to a shared gateway instead of Postgres.
The gateway is either a DB proxy (one RPC per query) or owns the engine and
calls workers for sync operations over the network.

- Pro: workers hold no database credentials.
- Con: as a DB proxy it reimplements PgBouncer or PostgREST, and the lock,
  LISTEN and archive gate must be re-expressed as RPCs. Connection count is
  unchanged.
- Con: as an engine tier, every guard and action becomes a network round trip
  while the instance lock is held, across machines.

### Option C: TS in-process, non-TS in a co-located executor

Keep TS sync operations inside the engine and add a co-located executor only for
Python, Rust and Go.

- Pro: no hop and no migration for TS projects. `meta.deps` keeps working for
  TS.
- Con: two execution paths with different capabilities (TS ops get a DB handle,
  others don't) and different failure modes, which must be kept at parity
  forever. The engine still imports project code and is still rebuilt per
  project.

### Option D: every sync operation in a separate executor, TS included (chosen)

The engine never runs user code. Every FSM version's sync operations run in a
**sync-operation executor**: a stateless process for that version's language, in
the same pod or host as the fsmlet, which dials the fsmlet over a Unix socket.
The fsmlet stays a single TypeScript implementation.

- Pro: one engine and one execution path. The protocol is the only contract, and
  every language, TypeScript included, goes through it.
- Pro: the engine becomes generic. It learns its operations from executor
  registrations, not from an imported generated file, so it no longer needs a
  per-project build and can later ship as a prebuilt image like the Activity
  Gateway.
- Pro: user code is isolated from the engine. A hung or crashing handler can't
  block the engine's event loop.
- Pro: it reuses SPEC-002's proto pipeline and follows the async SDKs' proven
  socket, session and reconnect design.
- Con: a Unix-socket round trip (about 50 to 100 µs) per operation call, for TS
  too: about 1 ms for a macrostep that calls 10 operations.
- Con: two processes per pod (the engine plus one executor per sync language it
  serves).
- Con: context and event are serialized to JSON on every call.
- Con: sync operations lose `meta.deps`. This is a breaking change for TS
  handlers that use it (see Decision 2).

### Option E: push more of the engine into SQL, then port

Move transition selection (with guard results passed in), action sequencing and
the archive into `fsm_core`, until a native loop per language is a thin "read,
call handlers, write" wrapper. Then do Option A cheaply.

- Pro: the long-term route to native single-process workers.
- Con: a large `fsm_core` redesign before any non-TS sync operation runs. Guards
  and actions still need several database round trips per macrostep. It doesn't
  conflict with D and can come later.

### Option F: do nothing

Document sync operations as TypeScript-only and stop generating non-TS sync
stubs.

- Pro: no work.
- Con: leaves both problems unsolved, and the polyglot promise (root `CLAUDE.md`
  point 1) covers actors only.

## Decision

**Option D, as a second fsmlet beside the in-process one.** A new fsmlet,
`@pgfsm/sync-worker-gateway`, never runs user code: every sync operation,
TypeScript included, runs in a per-language executor process that dials it over
a Unix socket. The in-process fsmlet, `@pgfsm/sync-worker`, stays as it is. A
deployment picks one per fsmlet. Both run instances through the same engine
package, `@pgfsm/fsm-engine`, so an FSM behaves the same in either.

Decision drivers:

- **One engine, one execution path.** The macrostep semantics (SPEC-010 to 014)
  are the most expensive code to get right. That rules out Option A. Two paths
  with different capabilities rule out Option C.
- **The hop is local and bounded.** The engine and executor are co-located, so
  the extra cost is microseconds per call. The instance lock is never held
  across a network round trip, which rules out Option B.
- **Reuse.** Proto contracts, Buf generation for four languages and a proven SDK
  session design already exist.
- **Keep the in-process fsmlet (revised).** Option C's cost was two execution
  paths that must be kept at parity forever. Sharing one engine package removes
  most of that: the macrostep, retries and definition check exist once, and only
  where a sync operation runs differs (in-process handler or executor call).
  Keeping it lets the executor path be tested against today's results on the
  same FSMs, avoids forcing TS users off `meta.deps`, and is the rollback.
  Whether to deprecate it is decided after the conformance suite (#744) shows
  parity.

### 1. Topology: the executor dials the engine

- The gateway listens on a Unix socket (`syncExecutors.socketPath`, file mode
  `0600`). Executors connect to it. In Kubernetes, the executor is a sidecar
  container that shares an `emptyDir` for the socket. Locally, it's a second
  process. This mirrors how SDK workers dial the Activity Gateway.
- The gateway is configured with the sync languages it accepts
  (`syncExecutors.languages: ["typescript", "python"]`). At startup it calls
  `registerFsmlet` with **no** FSM versions, so the scheduler routes it nothing.
  When an executor's registration is accepted (section 5), the gateway updates
  its `fsm_workerlet` row to add that executor's FSM versions. When an executor
  unregisters or its stream ends, it removes them again, after a short grace
  period that lets a restarting executor come back (`registerFsmlet` upserts, so
  each change is one call). Its row is always the union of its live executors'
  versions.
- TCP and remote executors are out of scope (see Non-goals).

### 2. What a sync operation receives: pure functions, no database

A sync operation receives the JSON `context`, the JSON `event`, the operation's
JSON `params` and a read-only `meta`:
`{fsmName, fsmVersion, instanceId, operationType, operationName, attempt}`. It
returns a value. It gets **no database handle and no pgmq message**, in every
language.

- Executors open **zero** pg connections, so the connection budget is unchanged.
- I/O belongs in invoked actors, as in XState, where it is retried, cancelled
  (SPEC-012) and observed.
- This applies to handlers run by an executor, TypeScript included. TS handlers
  run in-process by `@pgfsm/sync-worker` keep today's signature, `meta.deps`
  included (revised: no clean break). A TS handler that should run in both must
  not use `meta.deps`.

Results per operation type:

| Type     | Returns                                                 | Engine use                           |
| -------- | ------------------------------------------------------- | ------------------------------------ |
| `action` | new context, or "unchanged" (TS `undefined`, Py `None`) | replaces `current_context`, as today |
| `guard`  | boolean                                                 | lazy transition selection, as today  |
| `delay`  | number of ms, or "no value"                             | `resolveRaiseDelay`, as today        |
| `input`  | JSON value                                              | invoke input (SPEC-013), as today    |

Whether an operation is implemented is decided from the executor's registration,
before any call, so "missing implementation" behaves exactly as today (actions
skipped, guards false, inputs `null` with an error log).

### 3. Granularity: one call per operation, over one persistent stream

Each operation the macrostep invokes is one request/response, multiplexed by
`call_id` over the executor's persistent bidirectional stream. The engine calls
operations in exactly the order it calls them today. Guards stay lazy, and the
context is threaded action by action. Results are the same as XState's and as
today's in-process path.

Batching is not part of this spec. It can come later, only if measurements show
a need. It would have to keep this order: contiguous plain actions within one
phase, split at every `xstate.raise` and `xstate.invoke`.

The executor must handle up to `maxConcurrency` calls at once (one per instance
the fsmlet is driving). Executors are stateless: a handler must not rely on
in-memory state between calls.

### 4. Failure classification against SPEC-014

| Failure                                                  | Class     | Effect                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Handler raised / returned an error                       | operation | `SyncOperationError` with the remote `kind`, `name` and `message`. SPEC-014's attempts, backoff and final `error` apply unchanged.                                                                                                                                                                                                                                        |
| Call exceeded its deadline                               | operation | Counts as an attempt (`message: "deadline exceeded after <n> ms"`). A handler that always hangs can't pin its instance forever.                                                                                                                                                                                                                                           |
| Executor not connected, stream dropped, or invalid reply | transport | **Not** counted. The engine treats it as a platform error: the step is retried in place with SPEC-014's backoff, without an archive call, and succeeds once the executor is back. If the executor's grace period runs out first, the gateway removes its FSM versions and aborts their running workers, which releases their locks; their messages are redelivered later. |

- The deadline is per call: `syncOperationDeadlineMs` (default 10 000, with a
  per-FSM override, like `syncOperationRetry`).
- `startSyncWorkerGateway` refuses a configuration whose deadline isn't below
  the instance queue's visibility timeout.
- The engine's `callSyncOperation` wraps every throw in a `SyncOperationError`,
  which counts. The gateway throws a distinct transport error that the engine
  passes through uncounted (#743). In-process mode never throws it.
- While an executor is absent, its FSM versions aren't in the gateway's
  `fsm_workerlet` row, so no new entries for them are routed to it.

### 5. Registration and the SPEC-006 check move to the executor's `Register`

An executor's first message lists, for each FSM version it serves:

- `fsm_name`, `fsm_version` and `fsm_json_digest` (from the compiled
  definitions)
- every operation it implements, as `{type, name}`

The gateway:

- serves the **union** of its live executors' FSM versions, updated as they come
  and go (section 1). An actor-only FSM version is registered, with no
  operations, by the executor of its sync language (default `typescript`).
- rejects a `Register` that claims an FSM version another executor already
  serves.
- runs `checkFsmDefinitions` against these digests and operation lists instead
  of the imported `FSM_DEFINITIONS` and `SYNC_OPERATION_REGISTRATIONS`. The
  `missing`, `ambiguous`, `drifted`, `undigested` and `unimplemented` results
  keep their meaning. A failing check rejects the registration with every
  problem listed, so that executor's FSM versions are never added.
- rejects a `Register` whose language isn't in `syncExecutors.languages`, or
  whose protocol major version isn't the gateway's.

### 6. Protocol

The contract is a new proto package in `fsm-proto-codegen`
(`proto/fsm-sync-worker-ts/pgfsm/syncexecutor/v1/sync_executor.proto`, #736),
generated for TS, Python, Rust and Go into the separate `gen-sync/` packages
(`@pgfsm/proto-codegen-sync` and its counterparts). The gateway is the server,
and the executor opens one bidirectional `Session` stream:

```proto
service SyncExecutorService {
  rpc Session(stream SessionRequest) returns (stream SessionResponse);
}
// executor → gateway (SessionRequest):
//   Register{executor_id, language, protocol_version, sdk_version,
//            fsm_versions[{fsm_name, fsm_version, fsm_json_digest, operations[{type, name}]}]}
//   Heartbeat{executor_id}, Unregister{executor_id}
//   CallResult{call_id, oneof outcome {value_json, no_value, error{error_type, message, stack}}, duration_ms}
// gateway → executor (SessionResponse):
//   RegisterAck{accepted, engine_protocol_version, problems[{kind, fsm_name, fsm_version, message}]}
//   Call{call_id, fsm_name, fsm_version, operation_type, operation_name,
//        context_json, event_json, params_json, meta{instance_id, attempt}, deadline_ms}
//   Shutdown{reason}
```

The first message on a stream must be `Register`. A rejected registration gets
`RegisterAck{accepted: false}` listing every problem, and its stream ends. An
executor that registers again with the same `executor_id` replaces its earlier
session.

JSON values travel as JSON strings, so every language gets the same numbers and
keys back, not `google.protobuf.Struct`'s doubles.

### 7. Language per FSM version (compiler and CLI)

- An FSM version's sync language is the language its sync logic is generated in.
  The compiler refuses to generate sync logic for one FSM version in two
  languages.
- No `fsm.json` schema or SQL change is needed.
- For each language, the compiler generates that language's registry and
  definitions (digests) under `sync-worker/<lang>/`, plus a runnable executor
  entry point. The TS registry is still generated for `@pgfsm/sync-worker`'s
  in-process mode; the gateway imports no generated file.
- `@pgfsm/cli create/add` scaffolds the fsmlet entry and, for executor mode, the
  gateway entry and one executor per sync language.
- Input mapper stubs, today TypeScript-only, are generated for every language.

### 8. Where the code lives

- **Engine:** `packages/fsm-engine-ts`, npm `@pgfsm/fsm-engine` (Apache-2.0,
  #748). It runs one instance: the lock and pgmq loop, `macrostepV2`, transition
  selection, internal events, delays, invoke input, SPEC-014 retries and the
  SPEC-006 check. It never looks up handlers; it calls sync operations through
  `SyncOperations`: `has(type, name)` and
  `call({type, name, fsmName, fsmVersion, instanceId, attempt, context, event,
  params, message})`.
  It depends only on `@pgfsm/db`.
- **Fsmlets**, each with its own fsmlet loop (register, LISTEN, claim,
  heartbeat, fallback poll) on `@pgfsm/db`, and neither depending on the other:
  - `packages/fsm-sync-worker-ts`, `@pgfsm/sync-worker`: in-process. Unchanged
    public API; it turns its registrations into `SyncOperations` and calls
    handlers with today's arguments.
  - `packages/fsm-sync-worker-gateway-ts`, `@pgfsm/sync-worker-gateway`:
    executor mode. The socket server, the executor registry, the dynamic
    `fsm_workerlet` updates and the call dispatcher; its `SyncOperations` sends
    each call to the executor that registered the FSM version.
- **Executors:** in a new **sync-worker SDK** per language, separate from the
  async-worker SDKs. Each engine gets a matching SDK:

  | Engine                                | SDK                                                                       |
  | ------------------------------------- | ------------------------------------------------------------------------- |
  | `@pgfsm/sync-worker-gateway` (fsmlet) | `@pgfsm/sync-worker-sdk` and its Python, Rust and Go counterparts (below) |
  | `@pgfsm/async-worker-gateway`         | `@pgfsm/async-worker-sdk` and its Python, Rust and Go counterparts        |

  | Language   | Package directory                     | Published as                                                                                         |
  | ---------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
  | TypeScript | `packages/fsm-sync-worker-sdk-ts`     | npm `@pgfsm/sync-worker-sdk`                                                                         |
  | Python     | `packages/fsm-sync-worker-sdk-python` | PyPI `pgfsm-sync-worker-sdk`, imports `pgfsm.sync_worker_sdk`                                        |
  | Rust       | `packages/fsm-sync-worker-sdk-rust`   | crates.io `pgfsm-sync-worker-sdk`, `use pgfsm_sync_worker_sdk` (milestone 2)                         |
  | Go         | `packages/fsm-sync-worker-sdk-go`     | module `github.com/pgfsm/fsm/packages/fsm-sync-worker-sdk-go`, package `syncworkersdk` (milestone 2) |

  Why separate packages, not a `sync` entry point in the async SDKs:

  - **Every project in executor mode needs a sync executor**, including TS-only
    projects with no async actors. They shouldn't install an async-worker SDK
    and its actor-session code to run `assign` actions.
  - **Different servers, different compatibility.** The sync SDK speaks
    `syncexecutor/v1` to the sync worker gateway; the async SDK speaks
    `sidecargateway/v1` to the Activity Gateway. Each SDK versions and declares
    compatibility against its own server, so a protocol change in one doesn't
    force a release of the other.
  - **Different runtime models.** Sync executors serve many short concurrent
    calls with deadlines and no cancellation; async workers serve long invokes
    with cancellation (SPEC-012). Separate packages keep each API small.

  The transport code (socket dialing, the reconnect loop, logging setup) is
  small and is **copied** from the async SDKs rather than extracted into a
  shared `*-sdk-core` package in four languages. Extract it only if the copies
  start to drift. Each new package is Apache-2.0 (SPEC-017) with its own
  `LICENSE`, `CLAUDE.md`, README and release workflow (npm through trusted
  publishing and staged approval, #719).

### Rollout

- **Milestone 1:** protocol, the shared engine, the gateway, compiler and CLI
  changes, and the **TypeScript and Python** executors. Both pass one shared
  conformance suite, whose results also match `@pgfsm/sync-worker`'s in-process
  results. In-process execution stays.
- **Milestone 2:** Rust and Go executors, against the same suite.

### Non-goals

- Remote executors over TCP, and executors shared between fsmlets.
- Batching calls, or evaluating guards eagerly.
- Database access from sync operations, and any callback from executor to
  engine.
- Native engines in other languages (Options A and E remain open later).
- A published prebuilt fsmlet image or bin. This design makes one possible, but
  shipping it is a separate decision (SPEC-005 made the sync worker
  library-only).

## Consequences & migration

What gets harder:

- **Deployment (executor mode):** every gateway pod runs at least two containers
  or processes. Liveness covers both; the gateway serves an FSM version only
  while its executor is registered.
- **Latency:** each operation call pays a local IPC hop and JSON serialization.
  For very large contexts, that serialization dominates.
- **TS capabilities (executor mode):** TS sync operations run by the executor
  lose `meta.deps`. A handler that reads or writes Postgres must move that I/O
  into an invoked actor before moving to executor mode.
- **Two fsmlets to keep:** the in-process fsmlet and the gateway both release
  and must both pass the engine's tests. Sharing `@pgfsm/fsm-engine` limits the
  duplication to the fsmlet loop (about 300 lines each).
- **More packages to release:** `@pgfsm/fsm-engine` and
  `@pgfsm/sync-worker-gateway` on npm, and the sync-worker SDKs (an npm, a PyPI,
  a crates.io and a Go module release line, two in milestone 1), each with its
  own workflow and trusted-publishing setup. `@pgfsm/fsm-engine` must be
  published before the next `@pgfsm/sync-worker` release, which depends on it.
- **Concurrency inside executors:** Python handlers run concurrently up to
  `maxConcurrency` (asyncio, with blocking handlers sent to a thread pool), so
  user code must be safe to run concurrently.

Migration (opt-in; nothing changes for projects that don't switch):

1. Upgrading `@pgfsm/sync-worker` changes nothing for its users: same API, same
   handler signatures, same behaviour.
2. To switch an fsmlet to executor mode: move any `meta.deps` I/O into actors,
   regenerate with the executor entry points, replace `runFsmlet` with
   `runSyncWorkerGateway` and run one executor per sync language next to it.
3. In-process fsmlets and gateways can serve the same FSMs at once: both write
   through the same archive functions and no SQL changes, so mixed fleets are
   safe.

Rollback: switch the fsmlet entry back to `runFsmlet`. No database migration is
involved, and in-flight messages are redelivered as usual.

ADR follow-up: on acceptance, amend ADR-002 with a "Stage 4: user code out of
process" section, and ADR-003's connection accounting (executors: 0
connections).

## Acceptance criteria

- [ ] `@pgfsm/fsm-engine` runs instances for both fsmlets, depends only on
      `@pgfsm/db`, and calls sync operations only through `SyncOperations`.
- [ ] `@pgfsm/sync-worker`'s public API and handler signatures are unchanged,
      and its tests and the `apps/fsm-core-example` journey tests pass
      unchanged.
- [ ] `@pgfsm/sync-worker-gateway` imports no generated project file, never
      calls a sync handler in-process, and doesn't depend on
      `@pgfsm/sync-worker`.
- [ ] `sync_executor.proto` is in `fsm-proto-codegen`, and stubs are generated
      for TS, Python, Rust and Go by the existing Buf pipeline.
- [ ] The gateway registers in `fsm_workerlet` with no FSM versions, adds an
      executor's versions only once its registration passes the SPEC-006 check,
      and removes them when the executor leaves and its grace period ends. A
      failing check names every problem, and those versions are never added.
- [ ] A second executor that registers an FSM version already served is
      rejected, with the FSM version named.
- [ ] A shared conformance suite runs the same FSM fixtures (covering lazy guard
      selection across regions, action context threading, entry/exit/initial
      order, `after` delays, invoke input, `done.state` internal events and
      SPEC-014 failures) against the TS executor and the Python executor. Final
      state, context, error and archive arguments are identical to each other
      and to `@pgfsm/sync-worker`'s in-process results.
- [ ] A handler that raises fails the step as `SyncOperationError`
      `{kind, name, message}`. SPEC-014 attempts and the final `error` status
      apply unchanged.
- [ ] A call that exceeds `syncOperationDeadlineMs` counts as a failed attempt.
      `startSyncWorkerGateway` rejects a deadline that isn't below the
      visibility timeout.
- [ ] Killing the executor mid-macrostep: the step isn't archived and the
      attempt isn't counted. If the executor reconnects within its grace period,
      the step completes; otherwise its FSM versions are removed from the
      gateway's row and its workers aborted, and the message is redelivered.
      Either way the instance finishes with the same result as an uninterrupted
      run.
- [ ] No executor opens a pg connection: the sync-worker SDKs don't depend on
      `pg`, `@pgfsm/db` or a Python/Rust/Go Postgres driver.
- [ ] `fsm-sync-worker-sdk-ts` and `fsm-sync-worker-sdk-python` exist as their
      own packages (Apache-2.0, `LICENSE`, `CLAUDE.md`, release workflow), and
      `scripts/check-licenses.ts` passes. No sync-worker SDK depends on an
      async-worker SDK, and no async-worker SDK depends on a sync-worker SDK.
- [ ] TS sync handlers run by the TS executor receive `meta` without `deps`,
      `queueName` or `msg`, and generated executor stubs type-check against that
      signature. In-process handlers keep theirs.
- [ ] The compiler refuses to generate sync logic for one FSM version in two
      languages, and generates input mapper stubs for every language.
- [ ] `@pgfsm/cli create` with Python sync logic produces a project whose
      gateway plus Python executor runs `test-apps/debug-only`'s FSMs end to
      end.
- [ ] Milestone 2: the Rust and Go executors pass the same conformance suite.

## Implementation

Accepted in #735. Milestone 1 (TypeScript and Python):

| Issue | Scope                                                                                                   | Depends on             |
| ----- | ------------------------------------------------------------------------------------------------------- | ---------------------- |
| #736  | `syncexecutor/v1` proto and generated stubs                                                             | —                      |
| #742  | `@pgfsm/sync-worker-gateway`: socket server, executor registry, SPEC-006 check, dynamic `fsm_workerlet` | #736                   |
| #748  | `@pgfsm/fsm-engine`: the shared engine, `SyncOperations`                                                | #742                   |
| #743  | gateway: calls to executors, deadlines, transport errors, grace period, CLI entry                       | #748                   |
| #737  | `@pgfsm/sync-worker-sdk` (TypeScript executor)                                                          | #736                   |
| #738  | `pgfsm-sync-worker-sdk` (Python executor)                                                               | #736                   |
| #739  | compiler: per-language registries and executor entry points                                             | #737, #738             |
| #740  | CLI scaffolding and regenerated `test-apps`                                                             | #739, #743             |
| #744  | cross-language conformance suite                                                                        | #743, #737, #738, #739 |
| #741  | ADR-002 Stage 4, ADR-003 connection accounting, package and root docs                                   | #743                   |

Milestone 2 (Rust and Go executors) is cut once milestone 1 lands.

## Open questions

- **The gateway's license.** It's Apache-2.0 for now. It's a deployable server
  like the AGPL-3.0-only Activity Gateway, so it may belong under AGPL (SPEC-017
  amendment, `REUSE.toml`). `@pgfsm/fsm-engine` stays Apache-2.0, since
  `@pgfsm/sync-worker` links it.
- **Work claimed for an FSM version nobody serves.**
  `claim_scheduled_for_fsmlet` doesn't filter by `fsm_modules`, so the gateway
  can claim an entry routed before an executor left. The claim deletes the
  routing row. #743 decides how the instance is dispatched again (after checking
  how the scheduler treats an instance with queued messages and no routing row).
- **Grace period length** before a disconnected executor's FSM versions are
  removed (a few seconds; configurable?).
- **Deprecating the in-process fsmlet**, decided after #744 shows parity.
