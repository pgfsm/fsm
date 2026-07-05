# fsm-compiler-ts — TODO

Gaps tracked against the compiler PRDs in [`../prd/`](../prd/):

- [PRD-001: Design your FSM JSON schema](../prd/prd-001-design-fsm-json-schema.md)
- [PRD-002: Scaffold async operation logic](../prd/prd-002-scaffold-async-operation-logic.md)
- [PRD-003: Scaffold sync operation logic](../prd/prd-003-scaffold-sync-operation-logic.md)
- [PRD-004: Validate and load async operation logic](../prd/prd-004-validate-async-operation-logic.md)
- [PRD-005: Validate and load sync operation logic](../prd/prd-005-validate-sync-operation-logic.md)

Scaffolding is split into two commands/modules: `generate-async-logic`
(`src/generate-async-operation-logic.ts`) for actors, and `generate-sync-logic`
(`src/generate-sync-operation-logic.ts`) for actions/guards/delays. Shared
language templates + the folder walker live in
`src/operation-logic-scaffold.ts`.

## Design FSM JSON schema (PRD-001)

- [x] **Adopt schema v3.** Imports `fsm.machine.schema.v3.json` in
      `src/generate-fsm-json.ts`, `src/validate-and-load-fsm.ts`, and
      `src/validate-fsm-plugin-load.ts`.
- [x] **Wire `fsmLanguage` on invoke objects.** Backfilled (default
      `typescript`) and parsed onto `ActorReference`.
- [x] **Language-keyed scaffolding.** Actors are generated per invoke object's
      `fsmLanguage` (`generate-async-logic`); actions/guards/delays are
      generated in the `--lang` language(s) (`generate-sync-logic`). Supported
      languages: `typescript`, `python`, `rust`, `go`.
- [ ] **Native schema-validate command (optional).** The "from scratch" flow
      relies on external `ajv-cli` to validate a hand-authored `fsm.json`. A
      first-class `-c validate-schema` command (schema-only, no plugin exports,
      no DB) would let the compiler own the whole authoring loop.

## Scaffold async operation logic (PRD-002)

- [ ] **Fix actor stub signature.** `operation-logic-scaffold.ts` emits actor
      stubs as `<src>(context, event)` returning nothing, but actors are invoked
      as `actorFn(input): Promise<output>` (see
      `apps/fsm-core-worker-ts/src/fsmpromiseworker-helper.ts`). Emit an async,
      single-`input` stub returning `Promise`.
- [ ] **Distinguish internal vs external actors.** `extractFsmPluginRefs`
      carries `{ src, fsmType?, fsmVersion?, fsmLanguage? }` but no ownership
      signal, so a local stub is emitted for every `src`. External actors (owned
      by another fleet) should be referenced, not stubbed locally.
- [ ] **Idempotent regeneration.** `writeActorFile` (actors) and
      `writeOperationModule` (actions/guards/delays) in
      `src/operation-logic-scaffold.ts` overwrite their targets with
      `Deno.writeTextFile`, clobbering hand-written bodies. Skip files that
      already exist (or merge) rather than overwriting. (Applies to PRD-003.)
- [x] **Language-keyed actor scaffolding.** `generate-async-logic` writes one
      file per invoke at `<lang>/actors/<fsmType>_<fsmVersion>_<src>.<ext>`,
      routed by `fsmLanguage`.

## Scaffold sync operation logic (PRD-003)

Signatures below reference how the `fsmlet` worker invokes each kind in
`apps/fsm-core-worker-ts/src/fsmworker-helper.ts`. Validation only checks that a
name exports a `function` (not its arity), so mismatched stubs pass
`validate-sync-operation` but do not match the call convention.

- [ ] **Fix action stub signature.** Generator emits `<name>(context, event)`
      returning nothing; the worker calls
      `fn(current_context, action.params ??
      {}, meta)` and uses the return
      value as the new context. Emit `(context, params, meta)` and return the
      context.
- [x] **Delay stub returns a number.** Delay stubs now emit a numeric return
      (`: number` / `-> u64` / `int64`) in all languages, matching the "delay
      returns ms" contract.
- [ ] **Fix guard stub arity.** Generator emits `(context, event)`; the worker
      calls `fn(current_context, condObj, meta)`. Emit `(context, cond, meta)`
      (the `boolean` return is already correct).
- [ ] **Idempotent regeneration** (shared with PRD-002) applies equally to
      actions/guards/delays, since all kinds are written by
      `writeOperationModule`.

## Validate and load async operation logic (PRD-004)

Validation lives in `src/validate-async-operation-logic.ts`
(`validate-async-operation`); the validate-async-operation-and-load path lives
in `src/validate-async-operation-logic-and-load-to-db.ts`
(`validate-async-operation-and-load`).

- [ ] **Load actor metadata to PostgreSQL.** `validateAsyncOperationAndLoadToDb`
      validates and returns results but never persists actor
      name/version/language/queue. Wire the DB load the `asyncOperationlet`
      reads from.
- [ ] **Validate per-`fsmLanguage` actors on the load path.** The
      validate-async-operation-and-load path checks only `sharedPromise`
      dependency exports, not each invoke's actor per `fsmLanguage`. Reuse
      `validateAsyncOperationFromFolder`.
- [ ] **Arity/shape validation** (shared with PRD-002). Validation checks
      `typeof === "function"` only, so actor stubs with the wrong
      `(input) => Promise` signature still pass.

## Validate and load sync operation logic (PRD-005)

Validation lives in `src/validate-sync-operation-logic.ts`
(`validate-sync-operation`); the validate-sync-operation-and-load path lives in
`src/validate-sync-operation-logic-and-load-to-db.ts`
(`validate-sync-operation-and-load`), which loads verified machines via
`loadFsmFromJson` → `load_fsm_from_json_v2`.

- [ ] **Arity/shape validation** (shared with PRD-003).
      `validateLanguageModules` checks `typeof === "function"` only, so
      mismatched action/guard stub signatures still pass
      `validate-sync-operation` and load.
- [ ] **Validate non-TypeScript sync stubs.** `validateSyncOperationFromFolder`
      calls `validateLanguageModules(absPath, "typescript", …)` with the
      language hardcoded, so `python`/`rust`/`go` stubs are never validated.
- [ ] **Internal actors force-marked resolved.**
      `validateSyncOperationFromFolder` sets `resolved: true` on internal actors
      unconditionally (see `../limitations/bugs.md` Bug #5), hiding missing
      implementations.
