# PRD-005 — Validate and load sync operation logic

**Package:** `@pgfsm/compiler` (`packages/fsm-compiler-ts`) **Status:**
Partially implemented — see [Gaps](#gaps) and [TODO.md](../todo/TODO.md).
**Related:**
[PRD-003 — Scaffold sync operation logic](./prd-003-scaffold-sync-operation-logic.md),
[PRD-004 — Validate and load async operation logic](./prd-004-validate-async-operation-logic.md).

## Summary

Once the action / guard / delay stubs scaffolded in PRD-003 are filled in, the
compiler **validates** that each is exported with the right shape, then
**loads** the machine (`fsm.json`) into PostgreSQL. This is stage 5 of the FSM
lifecycle, derived from §5 of the root [`README.md`](../../../../README.md). The
`fsmlet` (root README §7) then drives the loaded machine, running this sync
operation logic inline inside each macrostep.

## Background

**Sync operation logic** is the set of `actions`, `guards`, and `delays`
referenced in `fsm.json`. Unlike actors (PRD-004), it runs **inline inside a
macrostep** of the `fsmlet` — no separate queue or process.

This stage does two things:

- **Validate** — confirm `fsm.json` follows the machine schema and that every
  referenced action/guard/delay (and internal actor) is exported as a function.
- **Load** — persist the validated machine into PostgreSQL so the `fsmlet` can
  load and drive it.

Two commands cover the stage:

| Command                            | Function                           | Module                                                |
| ---------------------------------- | ---------------------------------- | ----------------------------------------------------- |
| `validate-sync-operation`          | `validateSyncOperationFromFolders` | `src/validate-sync-operation-logic.ts`                |
| `validate-sync-operation-and-load` | `validateSyncOperationAndLoadToDb` | `src/validate-sync-operation-logic-and-load-to-db.ts` |

## Goals

- Validate `fsm.json` against `fsm.machine.schema.v3.json`.
- Validate that every referenced action, guard, delay, and internal actor is
  exported as a function; resolve external actor dependencies.
- Load the validated machine into PostgreSQL via `loadFsmFromJson`.
- Skip the DB load for any folder whose sync operation logic fails validation.

## Non-goals

- Scaffolding the stubs (PRD-003).
- Async actors — validate/load of async operation logic (PRD-004).
- Running the machine — the `fsmlet` / worker stage.

## Requirements

### R1 — Validate sync modules

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-sync-operation \
  -f apps/fsm-core-example/fsm \
  -w fsm
```

`validateSyncOperationFromFolder`:

- validates `fsm.json` against `fsm.machine.schema.v3.json` with Ajv (early
  return with defaults if the schema check fails);
- extracts action/guard/delay/actor refs via `extractFsmPluginRefs`;
- calls `validateLanguageModules` to import
  `<lang>/{actions,guards,delays}/index.ts` and confirm each referenced name is
  a `function`;
- resolves each external actor against the `--available-actors` list, flagging
  missing dependencies as failed methods.

**Status:** ✅ Implemented — `validateSyncOperationFromFolders` /
`validateSyncOperationFromFolder` (`src/validate-sync-operation-logic.ts`),
wired to the `validate-sync-operation` command.

### R2 — Validate and load to PostgreSQL

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-sync-operation-and-load \
  -f apps/fsm-core-example/fsm \
  -w fsm \
  --db-url postgresql://user:pass@localhost:5432/db
```

For each versioned folder, validate via `validateSyncOperationFromFolder`; when
`isFsmModuleVerified` is true, load the machine into PostgreSQL via
`loadFsmFromJson` → `load_fsm_from_json_v2`. Folders that fail validation are
returned in the results but not loaded. `--db-url` overrides `DATABASE_URL`.

**Status:** ✅ Implemented — `validateSyncOperationAndLoadToDb`
(`src/validate-sync-operation-logic-and-load-to-db.ts`), wired to the
`validate-sync-operation-and-load` command.

### R3 — Shape (arity) validation

`validateLanguageModules` confirms each name is a `function` via `typeof` but
does **not** check its arity or signature, so the action/guard stub-signature
mismatches from PRD-003 (gaps 1 and 3) still pass `validate-sync-operation` and
load. See [Gaps](#gaps) #1.

## Gaps

Tracked in [TODO.md](../todo/TODO.md):

1. **`typeof`-only validation** — `validateLanguageModules` checks only that a
   name is a `function`, not its arity, so mismatched action `(context, event)`
   and guard `(context, event)` stubs (PRD-003) validate and load despite not
   matching the worker's `(context, params, meta)` / `(context, cond, meta)`
   calling convention. Validate arity/shape, not just that the export exists.
2. **TypeScript-only module validation** — `validateSyncOperationFromFolder`
   calls `validateLanguageModules(absPath, "typescript", …)` with the language
   hardcoded, so `python`/`rust`/`go` sync stubs generated by
   `generate-sync-logic` are never validated. Validate every language present
   under the folder.
3. **Internal actors force-marked resolved** — `validateSyncOperationFromFolder`
   assigns `resolved: true` to internal actors unconditionally (see
   [`limitations/bugs.md`](../limitations/bugs.md) Bug #5), so a missing
   internal actor implementation is not surfaced as a failed dependency.

## Acceptance criteria

- `validate-sync-operation` rejects an `fsm.json` that fails schema validation.
  ✅
- `validate-sync-operation` reports each missing/incorrect action, guard, delay,
  and external-actor dependency. ✅
- `validate-sync-operation-and-load` loads only folders whose sync operation
  logic verified. ✅
- Stubs whose signature does not match the worker's calling convention are
  reported as failures. ❌ pending gap 1.
- Non-TypeScript sync stubs are validated. ❌ pending gap 2.
