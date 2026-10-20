# SPEC-011: Serverless Workflow Import — Compile `workflow.json` to `fsm.json`

| Field   | Value                                                                                                                                                                                   |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status  | Draft                                                                                                                                                                                   |
| Date    | 2026-10-07                                                                                                                                                                              |
| Authors | Niraj, Claude Code                                                                                                                                                                      |
| Issue   | #489                                                                                                                                                                                    |
| Affects | `packages/database-src` (FSM JSON schema), `packages/database-src-extension`, `packages/fsm-compiler-ts`, `packages/fsm-sync-worker-ts`, `packages/fsm-cli-ts`, new built-in actor pack |

---

## Problem

pgfsm runs one definition format: `fsm.machine.schema.v3.json`, an XState 5
statechart. Authors normally produce it from an XState `machine.ts` through
`fsm-compiler-ts`. The
[Serverless Workflow DSL 1.0.3](https://open-workflow-specification.org/) (CNCF;
schema at `https://open-workflow-specification.org/schemas/1.0.3/workflow.json`)
is a vendor-neutral standard for service orchestration. It is a different model:

- **Ordered task lists** (`do: [ {name: task}, … ]`) with implicit sequencing
  and `then: continue | exit | end | <task>` flow directives, where pgfsm uses
  event-driven states and transitions.
- **Inline runtime expressions** (`${ … }`, jq by default) for conditions, data
  shaping and call arguments, where pgfsm uses named action, guard and delay
  functions implemented in code.
- **Built-in integrations**
  (`call: http | openapi | grpc | asyncapi | mcp |
  a2a`,
  `run: container | shell | script | workflow`), where pgfsm `invoke`s
  user-written actors.
- **A data-flow model** (`input.from`, `output.as`, `export.as`, `$context`,
  `$workflow`, `$task`), where pgfsm has a single `context` object changed by
  actions.
- **A typed error model** (RFC 7807 problem details, `raise`, `try/catch` with
  error filters, `retry` policies), where pgfsm only has `xstate.error.actor.*`
  events.

Today an SW definition can't run on pgfsm without a hand rewrite into
`machine.ts`. That rewrite also hits two schema gaps that affect pgfsm users in
general, not only SW users:

1. **`invokeObject` cannot carry input.** It is `additionalProperties: false`
   with no `input` field. XState's `invoke.input` (used in
   `apps/fsm-core-example/fsm/creditCheck/v02/machine.ts`) is dropped when
   `fsm.json` is generated. An SW `call: http, with: {…}` has nowhere to put its
   arguments.
2. **No eventless (`always`) transitions.** Tasks that do no I/O (`set`,
   `switch`, `if`-skip) must advance without an external event. Neither the
   compiler nor the examples support eventless transitions today.

**Who / why now:** this is exploratory, roadmap-level work. There is no named
user waiting on it. The point is to decide whether SW can be a front-end DSL for
pgfsm, and at what cost, before anyone commits to it. The acceptance criteria
are therefore split into tiers (see below), and reviewers can accept tier 1
without committing to tiers 2 and 3.

## Constraints

- **ADR-002 (sync execution model, Stage 3):** instances are driven by
  `fsm_dispatch_queue → scheduler → fsmlet`. SW support must not add a second
  execution path; SW workflows run as ordinary pgfsm instances.
- **ADR-003 (polyglot actors via the Activity Gateway):** activity-tier workers
  hold **zero DB connections** and register with the gateway. Any built-in SW
  actor (HTTP call, emit, script runner) is an ordinary gateway worker. It is
  not a special case inside the fsmlet or the API.
- **Connection minimization (CLAUDE.md goal 4):** no new per-instance or
  per-task DB connections. Expression evaluation must not need a DB round trip
  per expression.
- **Schema change propagation:** changes to `fsm.machine.schema.v3.json` (and to
  extension SQL) follow `docs/schema-change-propagation.md`, fanning out through
  compiler, db client and sync worker types.
- **Compiler codegen uses Eta templates** with do-not-edit headers. Generated
  sync logic is TypeScript only today, under
  `sync-worker/typescript/<fsm>/<version>/`.
- **cwd anchoring (#305, #307, #372, #376):** compiler commands write to
  `{cwd}/fsm`, `{cwd}/sync-worker` and `{cwd}/async-worker`, and take an
  explicit `-N/-V` FSM identity in single-file mode. No `--output`.
- **SPEC-006:** definitions are loaded as a deploy step (`pgfsmctl fsm load`)
  and checked by digest at fsmlet startup. Imported FSMs go through the same
  path, with no special loader.
- **Backward compatibility:** every existing `fsm.json` must stay valid and
  behave the same. New schema fields are optional.

## Options considered

### Option A — Do nothing (publish a manual mapping guide)

Document how each SW construct maps to XState/pgfsm (the mapping table in
[D2](#d2--task--statechart-mapping)) and leave the conversion to authors.

- **Pros:** zero code and zero schema risk.
- **Cons:** the two schema gaps (invoke input, eventless transitions) still
  block faithful hand conversions. jq expressions must be rewritten by hand as
  TS. No interop story.

### Option B — Offline compiler `workflow.json → fsm.json` + generated logic + built-in actor pack (chosen)

A new `fsm-compiler-ts` command compiles an SW document into:

1. `{cwd}/fsm/<name>/<version>/fsm.json`: a statechart with one state per task.
2. `{cwd}/sync-worker/typescript/<name>/<version>/{actions,guards,delays}/`:
   generated TS functions, one per runtime expression, wrapping a jq evaluator.
3. References to a **built-in SW actor pack**, gateway workers that implement
   `call: http/openapi`, `emit` and `run: script`. `run: workflow` maps onto the
   existing `asyncOperationType: "fsm"`.

It needs two small, optional schema additions (`invokeObject.input`, `always`
transitions) and an extension change for eventless resolution.

- **Pros:** reuses the whole runtime (dispatch, durability, polyglot actors,
  scheduler, delays). One execution model. The schema additions also fix
  existing XState gaps (`invoke.input` is currently dropped).
- **Cons:** it is a lossy, one-way compile. You can't edit the `fsm.json` and
  convert it back to SW. Generated statecharts are verbose: one state per task,
  plus extra states for try/for/fork scaffolding. Some SW features have no home
  (see [Out of scope](#out-of-scope)).

### Option C — Transpile SW to an XState `machine.ts`, then reuse `generate-fsm-json`

Emit `machine.ts` source and let the existing pipeline produce `fsm.json`.

- **Pros:** less new compiler surface, and the output is readable XState.
- **Cons:** the `machine.ts → fsm.json` path is exactly where `invoke.input` and
  inline `assign` closures are lost today. Expressions would be embedded as JS
  closures that the path can't serialize, so they must become named functions
  anyway. It adds a codegen hop (source text → XState runtime → JSON) with no
  benefit over generating the JSON directly.

### Option D — Native SW interpreter tier

A separate runtime that executes SW documents directly (written for pgfsm, or an
existing SW runtime embedded and backed by pgmq for durability).

- **Pros:** highest spec fidelity, including `extensions`, `schedule` and exact
  data-flow semantics.
- **Cons:** a second execution model next to ADR-002's fsmlet, with its own
  dispatch, durability, connection budget and operations story. That contradicts
  the one-model goal and the connection-minimization constraint. It also leaves
  no shared tooling (`pgfsmctl instance *`, digests, actor coverage from
  SPEC-008).

## Decision

**Option B.** Decision drivers, in order:

1. **One execution model (ADR-002).** B and C reuse the fsmlet unchanged apart
   from eventless resolution. D adds a parallel runtime. A forces nothing but
   delivers nothing.
2. **Connection and actor-tier constraints (ADR-003).** B puts all SW I/O into
   gateway workers with zero DB connections. D would need its own DB access
   tier.
3. **Fixing the existing schema gaps.** `invokeObject.input` and `always` help
   every pgfsm author, not just SW importers. C keeps the lossy path that causes
   the gap.
4. **Fidelity is good enough.** Every task type the phase-1 scope needs has a
   statechart mapping (D2). The constructs that don't map are explicitly out of
   scope, not silently dropped.

C loses because it goes through the lossy `machine.ts` path for no benefit. D
loses on drivers 1 and 2. A remains the fallback if the tier 1 prototype shows
the generated statecharts are unworkably large.

### D1 — Command and identity

- `fsm-compiler-ts`:
  `import-serverless-workflow -f <workflow.json|yaml> -N
  <fsmName> -V <fsmVersion>`
  writes `{cwd}/fsm/<N>/<V>/fsm.json` and the generated sync logic under
  `{cwd}/sync-worker/typescript/<N>/<V>/`, using the same cwd anchoring as
  `generate-fsm-json`. `generate-all` accepts an SW file as another single-file
  input.
- `-N/-V` default to nothing. A suggested identity (from `document.namespace`,
  `document.name` and `document.version`) belongs in `@pgfsm/cli`
  (`pgfsm add --from-serverless-workflow`), consistent with SPEC-004.
- The source document's `document.dsl` must be `1.0.x`; anything else is
  rejected. Input is validated against the vendored 1.0.3 JSON Schema before
  compiling.
- Each generated state's `description` records the source task's JSON pointer
  (e.g. `/do/2/checkIt`), so transition logs can be traced back to the SW
  document.

### D2 — Task → statechart mapping

| SW construct                     | Compiles to                                                                                                                                                                 | Tier |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `do: [a, b, …]`                  | Compound state; children in order; `then: continue` (the default) → `always` to the next sibling, or `onDone` for invoking tasks                                            | 1    |
| `then: end` / `exit` / `<task>`  | Target the root `completed` final state / the enclosing compound's final child / the named sibling                                                                          | 1    |
| task `if:`                       | Guarded `always` around the task state (skip to its continuation)                                                                                                           | 1    |
| `set`                            | Entry action (generated) merging into the SW data model (D4), then `always` → continuation                                                                                  | 1    |
| `switch`                         | Guarded `always` transitions in case order; the `default` case has no guard                                                                                                 | 1    |
| `wait`                           | Delayed transition; the generated delay function converts the ISO 8601 duration (or `{seconds,…}` object) to ms                                                             | 1    |
| workflow / task `timeout`        | Delayed transition to a `sw.error` raise with type `…/errors/timeout`                                                                                                       | 1    |
| `call: http` / `call: openapi`   | `invoke` of built-in actor `sw.call.http` / `sw.call.openapi` with `input` (D3)                                                                                             | 1    |
| `run: workflow`                  | `invoke` with `asyncOperationType: "fsm"`, `src`/`asyncOperationVersion` from `namespace`/`name`/`version`                                                                  | 1    |
| `run: script` (`js` / `python`)  | `invoke` of `sw.run.script` in the matching `asyncOperationLanguage` (`typescript` / `python`)                                                                              | 1    |
| `listen: { to: { one \| any } }` | Atomic state with `on: { <event type>: … }`; the event filter's `with` becomes a guard                                                                                      | 2    |
| `listen: { to: { all } }`        | Parallel state, one region per event, each ending in a final state; `onDone` continues                                                                                      | 2    |
| `emit`                           | `invoke` of `sw.emit` (CloudEvents publish), fire and forget                                                                                                                | 2    |
| `fork`                           | Parallel state, one region per branch; `xstate.done.state.*` continues                                                                                                      | 2    |
| `fork.compete: true`             | Each region's final entry raises `sw.fork.won.<id>`; the parallel state's handler takes the first and exits                                                                 | 2    |
| `raise`                          | Entry action raising `sw.error` with an RFC 7807 payload                                                                                                                    | 3    |
| `try / catch`                    | Compound state; `on: sw.error` and `xstate.error.actor.*` with generated filter guards (`catch.errors.with`, `when`, `exceptWhen`) → `catch.do` sibling compound            | 3    |
| `catch.retry`                    | Context counter + delayed transition back into the `try` compound (backoff computed by the generated delay function); limit exceeded → fall through to `catch.do` / rethrow | 3    |
| `for` / `while`                  | Loop state with index in the data model; guard `index < len && while`; body compound; **back edge goes through a self-raised `sw.loop.next` event** (see D5)                | 3    |
| Uncaught `sw.error` at root      | `faulted` final state, error in the instance's final data                                                                                                                   | 1    |

### D3 — `invokeObject.input` (schema addition)

Add an optional `input` property to `invokeObject`: an arbitrary JSON value (a
template). Before dispatch, the sync worker resolves the template and attaches
the result as the invocation input, the existing gateway `inputJson` field. For
SW, the compiler emits `input` as a reference to a generated "input resolver"
sync function, which evaluates `${…}` leaves of `with` plus `input.from`. For
XState, `generate-fsm-json` stops dropping `invoke.input` when it is a named
function. Inline closures stay unsupported, as today. Follows
`docs/schema-change-propagation.md`.

### D4 — Expressions and the SW data model

- **Evaluator:** generated TS functions evaluate jq through a pinned jq library
  (WASM build) inside the TS sync worker. No DB or extension involvement, and no
  per-expression round trip. Only `jq` is supported for now.
  `document.evaluate.language: javascript` is rejected at import (it could be
  added later as a second backend).
- **Data model:** SW's data lives in the instance `context` under one reserved
  key, `"$sw"`, so it doesn't collide with user-defined context:
  `{ input, context, output, task }`. Workflow `input` is the instance's
  creation payload. Each task's `input.from`, `output.as` and `export.as`
  compile into generated actions that run on entry and on completion
  respectively. `$secrets` is **not** in the data model (see Out of scope).
- **Schema validation:** `input.schema` and `output.schema` are validated in the
  generated action. A failure raises `sw.error` with the SW validation error
  type.

### D5 — Eventless (`always`) transitions

Add optional `always: transitionObject[]` to atomic, compound and parallel state
nodes. Here the `eventType` is the reserved `xstate.always` and is not required
in the source. The transition-resolution loop (in the extension and fsmlet;
which side evaluates the guard follows the existing guard path) evaluates
`always` transitions after every microstep until no eligible one remains, then
commits the macrostep.

- **Loop bound:** a fixed per-macrostep bound on `always` microsteps (default
  100). Exceeding it faults the instance with a clear error, instead of looping
  forever.
- Because of the bound, **loop back edges never use `always`**. `for` and
  `while` raise `sw.loop.next`, so each iteration is its own durable macrostep.
  A 10k-item `for` is then 10k checkpoints, which is slow but correct and
  resumable.

### D6 — Built-in SW actor pack

A new TS (and, for `run: script` python, Python) gateway worker package. It
registers `sw.call.http`, `sw.call.openapi`, `sw.emit` and `sw.run.script` like
any other actor (ADR-003: zero DB connections). It returns
`{ status, headers, body }` per SW `output: content | response | raw`, and maps
non-2xx responses and transport failures to RFC 7807 errors (SW `communication`
error type), which arrive as `xstate.error.actor.*`. Authentication is limited
to references to environment-configured credentials in the worker (see Out of
scope).

### Out of scope

Rejected at import with a precise error naming the unsupported construct and its
JSON pointer:

- `schedule` (cron / every / after / on). Creating instances on a schedule is a
  `pgfsmctl` / pg_cron (SPEC-003) concern. A follow-up spec can map it.
- `extensions` (before/after task hooks).
- `use.secrets` and `use.authentications` beyond named references to credentials
  configured in the actor pack.
- `call: grpc | asyncapi | mcp | a2a` and `run: container | shell`. These can be
  added later as actors in the same pack with no schema change.
- `use.catalogs` / external `$ref` resources (`externalResource` endpoints are
  allowed; catalog resolution is not).
- Round-tripping `fsm.json` back to SW, and exporting native pgfsm FSMs to SW in
  general. A statechart can be encoded as SW with flat `listen` + `switch` +
  `then: <task>` goto blocks, but the encoding loses meaning:
  - Guards and actions are code, not jq, so they would become opaque
    `call: <custom function>` steps that only pgfsm can run.
  - Hierarchy, entry/exit ordering, history states and cross-region parallel
    semantics have no SW equivalent.
  - Delays and invokes racing events need `fork: compete` scaffolding.

  A narrow export (sequential, flat FSMs, for documentation or visualisation)
  can be a separate spec if anyone needs it.

## Consequences & migration

- **More output to read:** an imported SW workflow becomes a statechart with
  roughly 1–3 states per task, plus scaffolding states for try/for/fork.
  Transition logs show synthetic events (`sw.error`, `sw.loop.next`,
  `sw.fork.won.*`). The JSON-pointer `description` (D1) is the debugging aid.
- **The sync worker gains a jq dependency** (a WASM build). This affects bundle
  size and cold start of the TS sync worker, but only for FSMs that use it.
- **Generated code is not to be edited by hand.** Re-import replaces it,
  following the same rule as other compiler output.
- **Two one-way doors:** `invokeObject.input` and `always` are runtime
  semantics. Once FSMs depend on them they can't be removed without breaking
  those FSMs. Both are optional fields, so existing FSMs are unaffected.
- **Extension change:** `always` resolution touches the transition loop that
  every FSM uses. It needs regression coverage against the existing
  `compare-fsm-core-resolve-state-with-xstate-resolve-state` tests, with
  `always` added on the XState side.
- **Migration:** none is needed for existing users. Everything here is additive.
- **Rollback:** the importer and actor pack can be deprecated and removed
  independently. The schema additions stay; they are generally useful and
  independent of SW. If the tier 1 prototype shows the approach is unworkable,
  fall back to Option A and keep D3/D5 on their own merits.

## Acceptance criteria

### Tier 1 — schema additions + core flow + calls/runs

- [ ] `fsm.machine.schema.v3.json` accepts optional `invokeObject.input` and
      `always` on atomic/compound/parallel nodes. All existing example
      `fsm.json` files still validate, and their generated types and digests are
      regenerated per `docs/schema-change-propagation.md`.
- [ ] The extension and fsmlet resolve `always` transitions to a stable state
      within one macrostep. A cycle exceeding the bound faults the instance with
      a clear error. The resolve-state comparison tests pass with `always` cases
      added.
- [ ] `invoke.input` is resolved and delivered to the actor as its input,
      verified end to end through the gateway for at least the TS and Python
      SDKs. A named-function `invoke.input` in `machine.ts` survives
      `generate-fsm-json`.
- [ ] `import-serverless-workflow -f wf.json -N n -V v` writes
      `fsm/n/v/fsm.json` and `sync-worker/typescript/n/v/…` under cwd. The
      output validates against the schema and passes `validate-sync-operation`.
- [ ] An SW document that is invalid against the 1.0.3 schema, or uses an
      out-of-scope construct, is rejected with the construct and JSON pointer
      named. No partial output is written.
- [ ] Workflows using `do`, `then` (all four forms), `if`, `set`, `switch`,
      `wait`, `timeout`, `call: http`, `call: openapi`, `run: workflow` and
      `run: script` (js and python) run to completion on a local stack. The
      final `$sw.output` equals the expected output for each fixture.
- [ ] An uncaught error ends in the `faulted` final state with an RFC 7807
      payload.

### Tier 2 — events and concurrency

- [ ] `listen` (`one`, `any`, `all`) waits durably across fsmlet restarts and
      continues on matching events only; the event filter `with` is honoured.
- [ ] `emit` publishes a CloudEvent through `sw.emit`.
- [ ] `fork` runs branches concurrently and continues when all finish. With
      `compete: true` exactly one branch's output wins, and the others are
      exited.

### Tier 3 — errors and loops

- [ ] `raise` and actor failures are caught by the nearest `try` whose filter
      matches (`with`, `when`, `exceptWhen`); non-matching errors propagate.
- [ ] `retry` honours `limit.attempt.count`, `backoff`
      (constant/linear/exponential) and `jitter`, observable as delayed
      transitions in the instance history.
- [ ] `for` / `while` iterate with one macrostep per iteration and resume
      correctly after an fsmlet restart mid-loop.

### Conformance

- [ ] A fixture suite drawn from the SW specification's examples and its
      conformance test kit scenarios, for every construct in the implemented
      tiers, runs in CI.

## Open questions

- FSM version naming: SW `document.version` is semver (`1.0.0`), while pgfsm
  versions are folder names such as `v01`. Should `@pgfsm/cli` map them or just
  require `-V`?
- Is a WASM jq acceptable in the sync worker's dependency budget, or should the
  evaluator be a separate optional package that is loaded only when an imported
  FSM is present?

## Implementation

<!-- Filled in after acceptance: links to implementation issues and PRs. -->
