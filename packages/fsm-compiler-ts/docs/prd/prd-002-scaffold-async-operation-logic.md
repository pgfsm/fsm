# PRD-002 — Scaffold async operation logic (actors / `invoke` objects)

**Package:** `@pgfsm/compiler` (`packages/fsm-compiler-ts`) **Status:**
Partially implemented — see [Gaps](#gaps) and [TODO.md](../todo/TODO.md).
**Related:**
[PRD-001 — Design your FSM JSON schema](./prd-001-design-fsm-json-schema.md).

## Summary

Once an `fsm.json` exists, the compiler scaffolds **base (stub) code** for the
machine's **async operation logic** — the actors named by each state's `invoke`
objects. This is stage 2 of the FSM lifecycle, derived from §2 of the root
[`README.md`](../../../../README.md). The developer fills in the generated
stubs; the `asyncOperationlet` / promise worker later executes them.

## Background

An **actor** is a long-running async operation invoked when a state is entered
(`invoke.src`). Unlike sync operation logic (actions/guards/delays, PRD-003),
each actor runs in its own queue and process and reports back with
`xstate.done.actor.<id>` / `xstate.error.actor.<id>`.

Actors are split conceptually into:

- **Internal actors** — implemented and run inside this project.
- **External actors** — implemented and run by another service/fleet.

Stubs are written into `<lang>/actors/` — the language is chosen per actor from
its invoke object's `fsmLanguage` (`typescript`, `python`, `rust`, `go`).

## Goals

- Generate one file per invoke object at
  `<lang>/actors/<fsmType>_<fsmVersion>_<src>.<ext>`.
- Emit stubs whose signature matches how the worker actually invokes an actor.
- Route each actor to its `fsmLanguage` folder
  (`typescript`/`python`/`rust`/`go`).

## Non-goals

- Implementing actor bodies (developer's job).
- Sync operation logic — actions/guards/delays (covered by PRD-003).
- Validating/loading the filled-in stubs (covered by
  [PRD-004](./prd-004-validate-async-operation-logic.md)).
- Running actors — the `asyncOperationlet` / promise worker stage.

## Requirements

### R1 — Generate actor stubs from `fsm.json`

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate-async-logic \
  -f apps/fsm-core-example/fsm
```

- Walks every versioned folder, reads `fsm.json`, extracts actor references via
  `extractFsmPluginRefs`, and writes **one file per invoke** at
  `<lang>/actors/<fsmType>_<fsmVersion>_<src>.<ext>` (in the actor's
  `fsmLanguage` folder). Each file exports one function named after the actor
  `src`.
- Deduplicates by language + `<fsmType>_<fsmVersion>_<src>` — actors differing
  in type/version/src get their own files.

**Status:** ✅ Implemented — `generateAsyncOperationLogicFromFolders`
(`src/generate-async-operation-logic.ts`) using shared templates in
`src/operation-logic-scaffold.ts`, wired to the `generate-async-logic` command.

### R2 — Correct actor stub signature

The worker invokes an actor as a single-argument async function:

```ts
// how the worker calls it (fsmpromiseworker-helper.ts)
const result = await actorFn(eventPayload); // (input) => Promise<output>
```

So a generated actor stub should be:

```ts
export function checkBureau(
  input: {/* payload */},
): Promise<unknown> {
  // TODO: implement actor logic
  return Promise.resolve(/* ... */);
}
```

**Status:** ❌ Not implemented — the generator emits
`export function <src>(context: any, event: any) { /* TODO */ }` (returns void),
which does **not** match the `(input) => Promise` calling convention. See
[Gaps](#gaps) #1.

### R3 — Internal vs external actors

Each `invoke` object should be scaffolded according to whether its actor is
internal (stub generated here) or external (owned by another fleet — reference
only, not a local stub).

**Status:** ❌ Not implemented — `extractFsmPluginRefs` now collects
`{ src, fsmType?, fsmVersion?, fsmLanguage? }` but carries no ownership signal,
so the generator emits a local stub for every `src` regardless of ownership. See
[Gaps](#gaps) #2.

### R4 — Language-keyed scaffolding

Each `invoke` object's `fsmLanguage` (`typescript | python | rust | go`) selects
the target folder so a single machine can spread actors across runtimes.

**Status:** ✅ Implemented — `generate-async-logic` writes one file per invoke
into the actor's `fsmLanguage` folder (`typescript`, `python`, `rust`, `go`).
Actors with an unsupported `fsmLanguage` are skipped with a warning.

## Gaps

Tracked in [TODO.md](../todo/TODO.md):

1. **Actor stub signature mismatch** — generator emits `(context, event)`
   returning void; actors are invoked as `actorFn(input): Promise<output>` (per
   `processFSMPromiseQueueMessage`). Emit an async single-`input` stub returning
   `Promise`.
2. **No internal/external actor distinction** — actor refs now carry
   `fsmLanguage` but no ownership signal, so external actors still get local
   stubs they should not. Carry an ownership signal on the invoke object and
   skip local stub generation for external actors.
3. ✅ **Language-keyed scaffolding (resolved)** — `generate-async-logic` writes
   one file per invoke, routed by `fsmLanguage`
   (`typescript`/`python`/`rust`/`go`).
4. **Regeneration overwrites implementations** — `writeActorFile`
   (`src/operation-logic-scaffold.ts`) writes each actor file with
   `Deno.writeTextFile`, truncating any hand-written body. Make generation
   idempotent: skip files that already exist (or merge) rather than overwriting.

## Acceptance criteria

- `generate-async-logic` produces one actor stub per unique `invoke.src`. ✅
- Generated actor stubs are async, take a single `input`, and return a `Promise`
  — matching the worker's calling convention. ❌ pending gap 1.
- External actors are not given local stubs. ❌ pending gap 2.
- The target language(s) are chosen from each invoke object's `fsmLanguage`. ✅
- Re-running `generate-async-logic` does not clobber implemented actor bodies.
  ❌ pending gap 4.
