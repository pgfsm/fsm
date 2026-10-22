# SPEC-013: Per-Instance Input for Invoked Actors and Child FSMs

| Field   | Value                                                                                                                                                                                                                                         |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status  | Implemented                                                                                                                                                                                                                                   |
| Date    | 2026-10-22                                                                                                                                                                                                                                    |
| Authors | Niraj, Claude (Opus 5.5)                                                                                                                                                                                                                      |
| Issue   | #498                                                                                                                                                                                                                                          |
| Affects | `packages/fsm-compiler-ts` (fsm.json, input stubs, registries), `packages/fsm-sync-worker-ts` (input at invoke), `packages/database-src` (FSM JSON schema, instance creation and child start), `apps/fsm-core-example`, `test-apps/`, `docs/` |

Related: SPEC-006 (definition load and digest check), SPEC-010 (internal event
queue), SPEC-011 (invokes, child FSMs and their stale events), ADR-002 (sync
worker), ADR-003 (polyglot actors behind a queue).

---

## Problem

An invoked actor never receives anything from the instance that invoked it, and
an invoked child FSM always starts from an empty context.

XState passes data to an invoked actor through the invoke's `input`, which is
either a value or a function of the instance (verified in XState 5.32.3,
`resolveSpawn`):

```ts
input = typeof input === "function"
  ? input({ context, event, self }) // evaluated each time the invoke starts
  : input; // any other value, passed as-is
```

- A **static value** (`input: "EquiGavin"`,
  `input: { bureauName: "EquiGavin" }`) is handed to the actor unchanged, the
  same for every instance.
- A **mapper** (`input: ({ context, event }) => ({ ssn: context.SSN })`) runs
  when the invoke starts: after the transition's actions and the state's entry
  actions, with the context at that moment and the event that entered the state.
  Re-entering the state runs it again.
- **Mixing** fixed and runtime values is just a mapper with literals in it
  (`({ context }) => ({ bureauName: "EquiGavin", ssn: context.SSN })`). XState
  never merges a static value with context or event.
- An **invoked child machine** gets the input only through its own context
  factory (`context: ({ input }) => ({ ...defaults, ...input })`).

None of this survives into our runtime:

1. The compiler serializes the machine to `fsm.json`. A mapper is a function, so
   it's dropped.
2. The FSM JSON schema's `invokeObject` has no `input` property and
   `additionalProperties: false`, so even a static input has nowhere to go. No
   `fsm.json` in the repo carries `input`.
3. The sync worker forwards the invoke as it is (`fsmworker-helper.ts`, the
   `xstate.invoke` entry action), so every actor's input is `null`, and
   `start_child_fsm_v2` starts every child with `COALESCE(input, '{}')`.
4. A definition's own static `context` is stored by `fsm_load_v2` but never
   applied when an instance is created: `create_fsm_instance_from_name_v2` uses
   only the context its caller passes.

**Who is affected:**

- `apps/fsm-core-example`'s creditCheck: its bureau and report actors need the
  SSN from context and get `null`.
- #458's full-cycle load test can't vary actor work (`workMs`) per instance.
- Anyone porting an XState machine: mappers compile, and their actors silently
  get `null`.
- Invoked child FSMs: they always start from `{}`.

## Constraints

- **ADR-003 (polyglot actors behind a queue):** actors never touch the database,
  so they can't fetch instance data themselves. Their input must be computed
  before the actor message is queued.
- **ADR-002 / SPEC-006 (the sync worker):** sync operations (actions, guards,
  delays) are TypeScript stubs compiled into the sync worker. A loaded FSM
  version is immutable, and the sync worker refuses an `fsm.json` that differs
  from the definition it was compiled from.
- **Compatibility:** the `fsm.json` change must be additive and opt-in. An FSM
  that uses no input compiles to the same `fsm.json` as today.
- **Security:** no code may be stored as data and evaluated at runtime.
  Everything the sync worker runs is reviewed, type-checked source.
- **Schema changes** follow `docs/schema-change-propagation.md`.

## Options considered

### Option A — Named input stub

The compiler records a mapper as `"inputName"` on the invoke and generates a
TypeScript sync-operation stub taking `(context, event)`. The sync worker calls
it when the invoke starts. A static input is recorded as a literal `"input"`.
This is the pattern delays already use (`delayActionName`, a stub called with
`(context, event)`).

- **Pros:** exact XState semantics and timing. The logic is reviewed,
  type-checked, testable source. It reuses the registry, digest and missing-stub
  machinery.
- **Cons:** a new sync-operation kind across compiler, registry and sync worker.
  The mapper's logic must be ported into the stub.

### Option A′ — Option A, with the stub pre-filled from the mapper

As A, but when the compiler creates the stub it copies the mapper's source
(`fn.toString()`) into the stub's body, once. The stub is then user-owned, like
every other stub, and is never overwritten.

- **Pros:** porting a machine usually needs no hand-written input code. The
  runtime is identical to A.
- **Cons:** a mapper that uses something defined elsewhere in `machine.ts` (a
  constant, helper or import) copies a reference the stub doesn't have, so
  `deno check` fails at build time and the user fixes the stub. The copied code
  is the loader's JavaScript, without type annotations.

### Option B — Declarative mapping

The invoke's `input` in `fsm.json` is a template, such as
`{ "ssn": { "$context": "SSN" }, "bureauName": "EquiGavin" }`, resolved when the
invoke starts.

- **Pros:** no stubs. The data is inspectable and language-neutral.
- **Cons:** not XState syntax (users write a helper instead of a mapper). Only
  paths and literals, no logic. It tends to grow into an expression language,
  with the parsing and injection risks that brings.

### Option C — Evaluate the mapper source at runtime

The compiler stores the mapper's source in `fsm.json`, and the sync worker
evaluates it with `new Function`.

- **Pros:** nothing to write.
- **Cons:** code stored in the database and executed by a process holding
  database credentials. It can't be type-checked or tested like source, mappers
  that use outside variables break, and every edit changes the digest.

### Option D — Pass the whole context by default

When an invoke has no static input, the actor gets the instance's full context.

- **Pros:** no schema change.
- **Cons:** not XState behaviour. Every actor, every queue message and every
  event-log row gets all of the instance's data, including personal data. Actors
  become tied to the context's shape.

### Option E — Do nothing

- **Cons:** the problem stays. Actors can't fetch the data themselves (ADR-003).

## Decision

**Option A′**, with these rules.

### Drivers

1. **XState fidelity:** a ported `machine.ts` behaves the same. The input is a
   mapper over `(context, event)`, evaluated when the invoke starts.
2. **Security:** the code that builds inputs is reviewed source in the sync
   worker, the same trust model as actions, guards and delays. Nothing in
   `fsm.json` is executed. Only the requested fields reach the actor.

B loses on fidelity and long-term surface, C on security, D on data exposure and
fidelity, and E solves nothing. A′ is preferred over A because it removes the
hand-porting with no runtime difference.

### `fsm.json`

The compiler reads `input` from the machine config (not from `machine.toJSON()`)
and decides per invoke, with XState's own test:

| `input` in `machine.ts`                            | `fsm.json` invoke              | Stub                 |
| -------------------------------------------------- | ------------------------------ | -------------------- |
| a function                                         | `"inputName": "<name>"`        | yes, pre-filled (A′) |
| a string, number, boolean, `null`, array or object | `"input": <the value>`         | no                   |
| absent                                             | neither (unchanged from today) | no                   |

- `input` and `inputName` are mutually exclusive.
- A string is a **value**, not a reference to a named implementation (unlike
  action, guard and delay names elsewhere in `fsm.json`).
- A static value must be unchanged by `JSON.parse(JSON.stringify(...))`.
  Anything else (a `Date`, `undefined` fields, a `Map`) fails the compile and
  names the invoke.
- The FSM JSON schema's `invokeObject` gains `input` (any JSON) and `inputName`
  (string), with a rule that they're not both present.

### Stub naming (rule 1)

- The invoke's `id`, if the machine gives one.
- Otherwise `<state path>_<src>`: the state's path inside the machine, without
  the root id, joined with `_`, then the invoked `src`. For example
  `CheckingEquiGavin_CheckingForExistingReport_checkReportsTable`.
- When one state invokes the same `src` more than once, a numeric suffix keeps
  the names apart.
- Names are cleaned up the same way as operation file names, and names that
  collide afterwards fail the compile.

XState's generated id (`"<position>.<state node id>"`) is deliberately not used.
Its position prefix changes when invokes are added or reordered, which would
silently bind an existing stub to a different invoke. Renaming or moving a state
renames its id-less invoke's stub (a new stub, with the old one left unused), as
with action stubs today. Giving the invoke an `id` avoids that.

### The stub

Generated at `sync-worker/typescript/<fsm>/<version>/inputs/<name>/<name>.ts`,
registered with sync-operation type `input`:

```ts
// Input: equiGavinDBActor (invoke of checkReportsTable)
// Copied from machine.ts when this stub was created. It's yours now: edits
// to machine.ts don't update it.
export function equiGavinDBActor(context: any, event: any): unknown {
  const input = ({ context: { SSN } }) => ({
    bureauName: "EquiGavin",
    ssn: SSN,
  });
  return input({ context, event });
}
```

### Runtime

- The sync worker computes the input where it handles the `xstate.invoke` entry
  action. It uses the instance's context at that point (after this step's
  transition and entry actions) and the event that entered the state, and stores
  the result in the invoke's queue data. It's computed once, so redelivery and
  retries reuse it.
- This happens in the sync worker whatever the actor's language, so a Python,
  Rust or Go actor receives the input with no change to its SDK.
- **When the stub throws, returns something that isn't JSON, or is missing:**
  the sync worker logs it and the actor gets `null`. That's consistent with how
  action errors are handled today. A single error policy for every kind of sync
  operation is a follow-up (below).
- **Instance context:** an instance starts from its definition's static
  `context`, if `fsm.json` has one, shallow-merged with the context it's created
  with, which wins. For an API-created instance that's the API payload; for an
  invoked child FSM it's the invoke's input. A non-object input to a child FSM
  fails the compile when static. At runtime it's logged, and the child starts
  from its declared context alone.
- Static values are copied per invoke (through JSON), whereas XState hands every
  actor the same object. The value is the same, without shared-mutation risk.

## Consequences & migration

- **Persistence:** an invoke's input is stored in the actor's queue message and
  in `fsm_async_operation_queue_event_logs`, and since SPEC-007 it may cross the
  network to a worker. Mappers should return only what the actor needs.
- **More stubs:** each invoke with a mapper gets one.
- **Instance creation changes:** it now applies a definition's static `context`.
  No FSM in the repo declares one today (all have `"context": null`), but a user
  FSM with a static context gains those defaults on every new instance.
- **Migration of loaded FSM versions:** an FSM version whose `machine.ts` has
  input mappers compiles to a different `fsm.json`, which SPEC-006 forbids
  loading over the existing version. Add the recompiled machine as a **new
  version** (for example creditCheck `v02`), load it, and create new instances
  from it. Instances of the old version keep today's behaviour (`null` input)
  until they finish. An FSM without mappers or a static context recompiles to an
  identical `fsm.json` and needs nothing.
- **Mixed versions:** a sync worker older than this change, given a new
  `fsm.json`, ignores `input` and `inputName`, so the actor gets `null` as
  today. Ship the compiler, schema and sync worker together.
- **Rollback:** revert the sync worker and compiler, and keep creating instances
  of the old FSM version. Versions loaded with `input`/`inputName` stay loadable
  only while the schema accepts them, so roll back the schema last.

### Follow-ups (separate issues)

1. **Mapper `params` on actions and guards** are dropped the same way. They can
   reuse the named, pre-filled stub mechanism.
2. **Context factories** (`context: ({ input }) => …`, as creditCheck declares)
   are dropped the same way. They're a candidate for a "context stub" with the
   same mechanism.
3. **One error policy for sync operations:**
   - Actions that throw are logged and skipped.
   - Guards without an implementation count as `false`.
   - A guard that throws stalls its instance's event in a retry loop.
   - Delays without an implementation are sent immediately.
   - Inputs (this spec) log and use `null`.

   XState puts the machine into an error state for all of these.

## Acceptance criteria

### Compiler

- [ ] A static `input` (string, number, boolean, `null`, array or object) is
      written into the invoke in `fsm.json` as `"input": <value>`, unchanged. A
      value that changes after a JSON round trip fails the compile and names the
      invoke.
- [ ] An input mapper is written as `"inputName": "<name>"`, never together with
      `input`. It gets the stub
      `sync-worker/typescript/<fsm>/<version>/inputs/<name>/<name>.ts` taking
      `(context, event)`, pre-filled once from the mapper's source, and a
      registry entry with sync-operation type `input`.
- [ ] Stub names follow rule 1: the invoke's `id`; else `<state path>_<src>`; a
      numeric suffix when one state invokes the same `src` again. Names that
      collide after cleanup fail the compile.
- [ ] A child FSM invoke with a static non-object input fails the compile.
- [ ] A machine with a static `context` object compiles to `fsm.json` with that
      context.
- [ ] An FSM without input mappers, static inputs or a static context compiles
      to a byte-identical `fsm.json` (same SPEC-006 digest).
- [ ] The FSM JSON schema allows `input` (any JSON) and `inputName` (string) on
      an invoke, not both, propagated per `docs/schema-change-propagation.md`.

### Runtime

- [ ] When an invoke starts, its actor receives the static value, or the stub's
      result computed from the instance's context after this step's transition
      and entry actions and the event that entered the state. Tested with
      TypeScript, Python, Rust and Go actors.
- [ ] Two instances of one FSM version with different context give their actors
      different inputs.
- [ ] Re-entering the state computes the input again from the current context
      and event.
- [ ] The input is computed once and stored in the actor's queue message, so
      redelivery reuses it.
- [ ] An instance starts from its definition's static `context` shallow-merged
      with the context it's created with, which wins: the API payload, or a
      child FSM's input.
- [ ] A stub that throws, returns something that isn't JSON, or is missing is
      logged, and the actor gets `null`. A child FSM given a non-object input
      starts from its declared context alone.
- [ ] A sync worker older than this change, given a new `fsm.json`, behaves as
      today: the actor gets `null`.

### Examples, docs and follow-ups

- [ ] `apps/fsm-core-example`'s creditCheck is re-added as a new version whose
      bureau and report actors receive `{ bureauName, ssn }`.
- [ ] The e2e `loadTest` passes `workMs` per instance through input.
- [ ] Docs cover the migration (add a new version), that inputs are persisted,
      and the stub naming and rename caveat.
- [ ] Follow-up issues are filed: mapper `params`, context factories, and one
      error policy for sync operations.

## Implementation

Implemented as four stacked PRs, one per issue:

1. #584 (PR #592): FSM JSON schema (`input`, `inputName`) and instance creation
   from the declared static context.
2. #585 (PR #593): compiler: `fsm.json` input fields and the pre-filled input
   stubs; generated sync workers pin `@pgfsm/sync-worker` `^0.5.0`.
3. #586 (PR #594): sync worker: computing the input when an invoke starts.
4. #587: examples and test-apps: creditCheck `v03`, the `spec013Input`
   end-to-end test (CI), and `loadTest` `v02` passing `workMs`.

Release order: the database migration (2.1.18), then `@pgfsm/sync-worker` 0.5.0,
then the compiler (its generated projects pin `^0.5.0`).

Follow-ups: #588 (mapper `params`), #589 (context factories), #590 (one error
policy for sync operations).
