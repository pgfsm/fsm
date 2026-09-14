# PRD-004 — Validate async operation logic

**Package:** `@pgfsm/compiler` (`packages/fsm-compiler-ts`) **Status:**
Implemented — see [Gaps](#gaps) and [TODO.md](../todo/TODO.md). **Related:**
[PRD-002 — Scaffold async operation logic](./prd-002-scaffold-async-operation-logic.md),
[PRD-005 — Validate sync operation logic](./prd-005-validate-sync-operation-logic.md).

## Summary

Once the actor stubs scaffolded in PRD-002 are filled in, this stage
**validates** that each async operation-logic module actually exports its named
function. This is part of §3 ("Validate operation logic") of the root
[`DEVELOPER.md`](../../../../DEVELOPER.md).

## Background

**Async operation logic** is the set of actors named by each state's `invoke`
objects (`invoke.src`). Each actor is authored in the language declared by its
`asyncOperationLanguage` and lives in `<lang>/actors/<src>/`;
`sharedAsyncOperation` modules are the reusable dependency modules those actors
build on.

This stage confirms each filled-in actor / async module exports the named
function with the expected shape, per its `asyncOperationLanguage`.

| Concern  | Function                              | Module                                     |
| -------- | ------------------------------------- | ------------------------------------------ |
| Validate | `validateAsyncOperationFromFoldersV2` | `src/validate-async-operation-logic-v2.ts` |

## Goals

- Validate that every async operation-logic module exports its named function,
  routed by `asyncOperationLanguage` (`typescript`/`python`/`rust`/`go`).
- Fail loudly when any async module is missing or does not export its function.

## Non-goals

- Scaffolding the actor stubs (PRD-002).
- Sync operation logic — actions/guards/delays (PRD-005).
- Running actors — the `asyncOperationWorkerlet` / promise worker stage.

## Requirements

### R1 — Validate async modules per `asyncOperationLanguage`

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-async-operation \
  -f apps/fsm-core-example/fsm \
  -w sharedAsyncOperation \
  --skip-dirs carVitals,creditCheck,taskMachineConfig
```

`validateAsyncOperationFromFoldersV2` walks each requested language's `actors/`
directory (extracted via `extractFsmPluginRefs`) and for each actor calls the
appropriate language runtime to verify the named function is defined in the
actor file:

| Language     | Checker script             | Runtime invoked                                          |
| ------------ | -------------------------- | -------------------------------------------------------- |
| `typescript` | `src/checkers/check_fn.ts` | `deno run --allow-all check_fn.ts <file> <fn>`           |
| `python`     | `src/checkers/check_fn.py` | `python3 check_fn.py <file> <fn>`                        |
| `go`         | `src/checkers/check_fn.go` | compiled once with `go build`, binary cached per process |
| `rust`       | `src/checkers/check_fn.rs` | compiled once with `rustc`, binary cached per process    |

Each checker script exits 0 if the function is found, 1 if not, 2 on bad
arguments or parse/import error. For Rust and Go, the binary is compiled on
first use and reused for subsequent actors in the same process.

Actors with an unsupported `asyncOperationLanguage` are skipped with a warning.

**Status:** ✅ Implemented — `validateAsyncOperationFromFoldersV2`
(`src/validate-async-operation-logic-v2.ts`), wired to the
`validate-async-operation` command. This validates each invoke's actor per its
own `asyncOperationLanguage` folder directly — it is not scoped to
`sharedAsyncOperation` dependency modules only.

### R1a — Language filter (`--lang`)

```bash
# Validate TypeScript actors only
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-async-operation \
  -f apps/fsm-core-example/fsm \
  -w sharedAsyncOperation \
  --skip-dirs carVitals,creditCheck,taskMachineConfig \
  --lang typescript

# Multiple languages
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-async-operation \
  -f apps/fsm-core-example/fsm \
  -w sharedAsyncOperation \
  --skip-dirs carVitals,creditCheck,taskMachineConfig \
  --lang typescript,python
```

The `--lang` flag (comma-separated) restricts which `asyncOperationLanguage`
actors are validated. Omit `--lang` to validate all languages present.

**Status:** ✅ Implemented — `runtimeLanguages: OperationLang[] = []` parameter
on `validateAsyncOperationFromFoldersV2`; wired to the `--lang` CLI flag.

### R2 — Shape (arity) validation

Validation confirms each name is a `function` via `typeof` but does **not**
check its arity or signature, so an actor whose stub signature does not match
the worker's `(input) => Promise<output>` calling convention (PRD-002, gap 1)
still passes. See [Gap 1](#gaps).

## Gaps

Tracked in [TODO.md](../todo/TODO.md):

1. **`typeof`-only validation** — no arity/signature check, so actor stubs with
   the wrong signature (PRD-002, gap 1) still validate. Validate the
   `(input) => Promise` shape, not just that the export is a function.

## Acceptance criteria

- `validate-async-operation` reports, per actor, whether its
  `asyncOperationLanguage` module exports the named function. ✅
- Each language's runtime is called to confirm function presence — not just file
  existence. ✅ (`deno run` / `python3` / `go build` → binary / `rustc` →
  binary)
- `--lang` restricts which languages are validated; omitting it validates all.
  ✅
- Each invoke's actor is validated per its own `asyncOperationLanguage`, not
  just `sharedAsyncOperation` dependency modules. ✅
- Stubs whose signature does not match the worker's calling convention are
  reported as failures. ❌ pending gap 1.
