# SPEC-018: Sync Operations Run in Separate Per-Language Executors

| Field   | Value                                                                                                                                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status  | Draft                                                                                                                                                                                                                     |
| Date    | 2026-11-24                                                                                                                                                                                                                |
| Authors | Niraj, Claude                                                                                                                                                                                                             |
| Issue   | #734                                                                                                                                                                                                                      |
| Affects | `packages/fsm-sync-worker-ts`, `packages/fsm-proto-codegen`, `packages/fsm-compiler-ts`, `packages/fsm-cli-ts`, `packages/fsm-async-worker-sdk-ts`, `packages/fsm-async-worker-sdk-python` (Rust, Go SDKs in milestone 2) |

---

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
  executors live in the SDKs.
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
- Pro: it reuses SPEC-002's proto pipeline and the SDKs' socket, session and
  reconnect code.
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

**Option D.** The fsmlet engine is the only engine. It never runs user code.
Every sync operation, TypeScript included, runs in a per-language executor
process that dials the fsmlet over a Unix socket.

Decision drivers:

- **One engine, one execution path.** The macrostep semantics (SPEC-010 to 014)
  are the most expensive code to get right. That rules out Option A. Two paths
  with different capabilities rule out Option C.
- **The hop is local and bounded.** The engine and executor are co-located, so
  the extra cost is microseconds per call. The instance lock is never held
  across a network round trip, which rules out Option B.
- **Reuse.** Proto contracts, Buf generation for four languages and SDK session
  code already exist.

### 1. Topology: the executor dials the engine

- The fsmlet listens on a Unix socket (`syncExecutorSocket`, file mode `0600`).
  Executors connect to it. In Kubernetes, the executor is a sidecar container
  that shares an `emptyDir` for the socket. Locally, it's a second process. This
  mirrors how SDK workers dial the Activity Gateway.
- The fsmlet is configured with the sync languages it expects
  (`syncExecutors: ["typescript", "python"]`). It doesn't call `registerFsmlet`,
  and so gets no dispatch, until one executor per expected language has
  registered.
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
- This is a **clean break** for TypeScript: `meta.deps`, `meta.queueName` and
  `meta.msg` are removed from TS sync handlers in the same release. There is no
  transitional in-process mode.

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

| Failure                                                  | Class     | Effect                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Handler raised / returned an error                       | operation | `SyncOperationError` with the remote `kind`, `name` and `message`. SPEC-014's attempts, backoff and final `error` apply unchanged.                                                                                                              |
| Call exceeded its deadline                               | operation | Counts as an attempt (`message: "deadline exceeded after <n> ms"`). A handler that always hangs can't pin its instance forever.                                                                                                                 |
| Executor not connected, stream dropped, or invalid reply | transport | **Not** counted. The step is abandoned without an archive call and the instance lock is released. The pgmq message is redelivered after its visibility timeout. The fsmlet stops taking work for that language until the executor re-registers. |

- The deadline is per call: `syncOperationDeadlineMs` (default 10 000, with a
  per-FSM override, like `syncOperationRetry`).
- `startFsmlet` refuses a configuration whose deadline isn't below the instance
  queue's visibility timeout.
- While an expected executor is absent, the fsmlet deregisters from the
  scheduler, so no new entries are routed to it. It registers again once every
  expected executor is back.

### 5. Registration and the SPEC-006 check move to the executor's `Register`

An executor's first message lists, for each FSM version it serves:

- `fsm_name`, `fsm_version` and `fsm_json_digest` (from the compiled
  definitions)
- every operation it implements, as `{type, name}`

The fsmlet:

- serves the **union** of its executors' FSM versions. An actor-only FSM version
  is registered, with no operations, by the executor of its sync language
  (default `typescript`).
- rejects a `Register` that claims an FSM version another executor already
  serves.
- runs `checkFsmDefinitions` against these digests and operation lists instead
  of the imported `FSM_DEFINITIONS` and `SYNC_OPERATION_REGISTRATIONS`. The
  `missing`, `ambiguous`, `drifted`, `undigested` and `unimplemented` results
  keep their meaning. A failing check rejects the registration with every
  problem listed, so the fsmlet never registers with the scheduler.

### 6. Protocol

The contract is a new proto package in `fsm-proto-codegen`
(`proto/fsm-sync-worker-ts/pgfsm/syncexecutor/v1/sync_executor.proto`),
generated for TS, Python, Rust and Go. The engine is the server, and the
executor opens one bidirectional `Session` stream:

```proto
service SyncExecutorService {
  rpc Session(stream ExecutorMessage) returns (stream EngineMessage);
}
// executor → engine: Register{language, sdk_version, fsm_versions[]}, Heartbeat,
//                    CallResult{call_id, oneof {value_json, unchanged, error{kind, name, message, stack}}}
// engine → executor: RegisterAck{accepted, problems[]}, Call{call_id, fsm_name, fsm_version,
//                    operation_type, operation_name, context_json, event_json, params_json,
//                    meta, deadline_ms}, Shutdown
```

JSON values travel as JSON strings, so every language gets the same numbers and
keys back, not `google.protobuf.Struct`'s doubles.

### 7. Language per FSM version (compiler and CLI)

- An FSM version's sync language is the language its sync logic is generated in.
  The compiler refuses to generate sync logic for one FSM version in two
  languages.
- No `fsm.json` schema or SQL change is needed.
- For each language, the compiler generates that language's registry and
  definitions (digests) under `sync-worker/<lang>/`, plus a runnable executor
  entry point. For TS this replaces today's role of
  `sync-operation-registry-aggregate.generated.ts`, which the engine no longer
  imports.
- `@pgfsm/cli create/add` scaffolds the fsmlet entry and one executor per sync
  language.
- Input mapper stubs, today TypeScript-only, are generated for every language.

### 8. Where the code lives

- **Engine:** `fsm-sync-worker-ts`. The executor client, the call dispatcher,
  the registration gate and the transport-failure handling replace the
  in-process handler lookup in `fsmworker-helper.ts`.
- **Executors:** in the existing per-language SDKs, as a separate `sync` entry
  point next to the async-worker one, sharing their socket and session code.
  Whether to rename the SDK packages (they're named `async-worker-sdk`) is a
  follow-up, not part of this spec.

### Rollout

- **Milestone 1:** protocol, engine change, compiler and CLI changes, and the
  **TypeScript and Python** executors. Both pass one shared conformance suite.
  This release removes in-process execution.
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

- **Deployment:** every fsmlet pod runs at least two containers or processes.
  Liveness covers both, and the fsmlet's readiness depends on its executors
  being registered.
- **Latency:** each operation call pays a local IPC hop and JSON serialization.
  For very large contexts, that serialization dominates.
- **TS capabilities:** TS sync operations lose `meta.deps`. A handler that read
  or wrote Postgres must move that I/O into an invoked actor, or into an action
  that only sets context for a later actor.
- **Concurrency inside executors:** Python handlers run concurrently up to
  `maxConcurrency` (asyncio, with blocking handlers sent to a thread pool), so
  user code must be safe to run concurrently.

Migration (clean break, one release):

1. Upgrade `@pgfsm/sync-worker`, `@pgfsm/compiler` and `@pgfsm/cli`, and
   regenerate. TS handlers keep their names and folders. Only the `meta`
   argument changes. A handler that uses `meta.deps` fails type-check, which
   shows exactly where I/O must move.
2. Run the generated TS executor next to the fsmlet (sidecar or second process)
   and set `syncExecutors`.
3. During a rolling deploy, an old fsmlet and a new one serve the same FSMs.
   Both write through the same archive functions, and no SQL changes, so mixed
   fleets are safe.

Rollback: redeploy the previous `@pgfsm/sync-worker` and project build. No
database migration is involved, and in-flight messages are redelivered as usual.
A TS handler already rewritten without `meta.deps` still runs on the old engine.

ADR follow-up: on acceptance, amend ADR-002 with a "Stage 4: user code out of
process" section, and ADR-003's connection accounting (executors: 0
connections).

## Acceptance criteria

- [ ] The fsmlet engine imports no generated project file. `fsmlet.ts` has no
      import of `SYNC_OPERATION_REGISTRATIONS` or `FSM_DEFINITIONS`, and no code
      path calls a sync handler in-process.
- [ ] `sync_executor.proto` is in `fsm-proto-codegen`, and stubs are generated
      for TS, Python, Rust and Go by the existing Buf pipeline.
- [ ] An fsmlet configured with `syncExecutors: [L…]` doesn't call
      `registerFsmlet` until an executor for every `L` has registered and the
      SPEC-006 check has passed on the union of their registrations. A failing
      check names every problem and the fsmlet never registers.
- [ ] A second executor that registers an FSM version already served is
      rejected, with the FSM version named.
- [ ] A shared conformance suite runs the same FSM fixtures (covering lazy guard
      selection across regions, action context threading, entry/exit/initial
      order, `after` delays, invoke input, `done.state` internal events and
      SPEC-014 failures) against the TS executor and the Python executor. Final
      state, context, error and archive arguments are identical to each other
      and to today's in-process results.
- [ ] A handler that raises fails the step as `SyncOperationError`
      `{kind, name, message}`. SPEC-014 attempts and the final `error` status
      apply unchanged.
- [ ] A call that exceeds `syncOperationDeadlineMs` counts as a failed attempt.
      `startFsmlet` rejects a deadline that isn't below the visibility timeout.
- [ ] Killing the executor mid-macrostep: the step isn't archived, the attempt
      isn't counted, the message is redelivered, and the fsmlet deregisters,
      then re-registers once the executor reconnects. The instance then finishes
      with the same result as an uninterrupted run.
- [ ] No executor opens a pg connection: the executor packages don't depend on
      `pg`, `@pgfsm/db` or a Python/Rust/Go Postgres driver.
- [ ] TS sync handlers receive `meta` without `deps`, `queueName` or `msg`, and
      generated TS stubs type-check against the new signature.
- [ ] The compiler refuses to generate sync logic for one FSM version in two
      languages, and generates input mapper stubs for every language.
- [ ] `@pgfsm/cli create` with Python sync logic produces a project whose fsmlet
      plus Python executor runs `test-apps/debug-only`'s FSMs end to end.
- [ ] Milestone 2: the Rust and Go executors pass the same conformance suite.

## Implementation

<!-- Filled in after acceptance: links to implementation issues and PRs. -->
