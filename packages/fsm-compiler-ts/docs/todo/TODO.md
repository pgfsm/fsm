# fsm-compiler-ts — TODO

Gaps tracked against the compiler PRDs in [`../prd/`](../prd/):

- [PRD-001: Design your FSM JSON schema](../prd/prd-001-design-fsm-json-schema.md)
- [PRD-002: Scaffold async operation logic](../prd/prd-002-scaffold-async-operation-logic.md)
- [PRD-003: Scaffold sync operation logic](../prd/prd-003-scaffold-sync-operation-logic.md)
- [PRD-004: Validate async operation logic](../prd/prd-004-validate-async-operation-logic.md)
- [PRD-005: Validate sync operation logic](../prd/prd-005-validate-sync-operation-logic.md)

Scaffolding is split into two commands/modules: `generate-async-logic`
(`src/generate-async-operation-logic.ts`) for actors, and `generate-sync-logic`
(`src/generate-sync-operation-logic.ts`) for actions/guards/delays. Shared
language templates + the folder walker live in
`src/operation-logic-scaffold.ts`.

## Design FSM JSON schema (PRD-001)

- [x] **Adopt schema v3.** Imports `fsm.machine.schema.v3.json` in
      `src/generate-fsm-json.ts` and `src/validate-sync-operation-logic.ts`.
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
      file per invoke at `<lang>/actors/<src>/<src>.<ext>` (a subfolder named
      after the actor `src`), routed by `fsmLanguage`.
- [ ] **Dedup key regressed to `lang/src` only.**
      `generateAsyncOperationLogicFromFolders` dedupes by
      `${lang}/${actorFileBaseName(actor)}` (src only) — two invokes sharing a
      `src` but differing in `fsmType`/`fsmVersion` collapse into the same file,
      a collision that was previously fixed by deduping on the full
      `<fsmType>_<fsmVersion>_<src>` key. That fix was lost when the file layout
      moved to per-`src` subfolders. Either accept one file per `src` per
      language as the intended contract, or restore a type/version-aware key
      (and folder layout) if collisions are actually possible in practice.

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

## Validate async operation logic (PRD-004)

Validation lives in `src/validate-async-operation-logic-v2.ts`
(`validateAsyncOperationFromFoldersV2`, wired to `validate-async-operation`).

- [x] **Runtime validation for all four languages.** `validate-async-operation`
      calls each language's runtime (`deno run check_fn.ts` /
      `python3
      check_fn.py` / `go build check_fn.go` → binary /
      `rustc check_fn.rs` → binary) to confirm the named function is defined —
      not just that the file exists. Checker scripts live in `src/checkers/`.
- [x] **Language filter (`--lang`).** `validateAsyncOperationFromFoldersV2`
      accepts `runtimeLanguages: OperationLang[] = []` (empty = all); wired to
      `--lang` in the CLI for `validate-async-operation`.
- [x] **Validate per-`fsmLanguage` actors, not just `sharedPromise`.**
      `validateAsyncOperationFromFoldersV2` walks every requested language
      folder's `actors/` directory directly (not scoped to `sharedPromise`
      dependency exports).
- [ ] **Arity/shape validation** (shared with PRD-002). Validation checks that
      the export is a `function` but not its arity, so actor stubs with the
      wrong `(input) => Promise` signature still pass.

## Validate sync operation logic (PRD-005)

Validation lives in `src/validate-sync-operation-logic.ts`
(`validateSyncOperationFromFolders`, wired to `validate-sync-operation`) and
only checks that stubs are exported with the right shape.

- [ ] **Arity/shape validation** (shared with PRD-003).
      `validateLanguageModules` checks `typeof === "function"` only, so
      mismatched action/guard stub signatures still pass
      `validate-sync-operation`.
- [ ] **Validate non-TypeScript sync stubs.** `validateSyncOperationFromFolder`
      calls `validateLanguageModules(absPath, "typescript", …)` with the
      language hardcoded, so `python`/`rust`/`go` stubs are never validated.
- [ ] **`--available-actors` / external-actor resolution is a no-op.**
      `validateSyncOperationFromFolder` and `validateSyncOperationFromFolders`
      accept and pass through an `availableActors` parameter (wired to
      `--available-actors` on the CLI), but nothing in the current
      implementation reads it — no external-actor dependency check actually
      happens. Either wire it up or remove the dead parameter and flag.
