# PRD-004 — Validate and load async operation logic

**Package:** `@pgfsm/compiler` (`packages/fsm-compiler-ts`) **Status:**
Partially implemented — see [Gaps](#gaps) and [TODO.md](../todo/TODO.md).
**Related:**
[PRD-002 — Scaffold async operation logic](./prd-002-scaffold-async-operation-logic.md),
[PRD-005 — Validate and load sync operation logic](./prd-005-validate-sync-operation-logic.md).

## Summary

Once the actor stubs scaffolded in PRD-002 are filled in, the compiler
**validates** that each async operation-logic module actually exports its named
function, then **loads** the actor metadata into PostgreSQL. This is stage 4 of
the FSM lifecycle, derived from §4 of the root
[`README.md`](../../../../README.md). The `asyncOperationlet` / promise worker
(root README §6) later reads that metadata to spawn a process per actor queue.

## Background

**Async operation logic** is the set of actors named by each state's `invoke`
objects (`invoke.src`). Each actor is authored in the language declared by its
`fsmLanguage` and lives in `<lang>/actors/`; `sharedPromise` modules are the
reusable dependency modules those actors build on.

This stage does two things:

- **Validate** — confirm each filled-in actor / async module exports the named
  function with the expected shape, per its `fsmLanguage`.
- **Load** — persist the async operation-logic metadata (actor name, version,
  language, queue) into PostgreSQL so the control plane knows what is runnable.

Two commands cover the stage:

| Command                             | Function                            | Module                                                 |
| ----------------------------------- | ----------------------------------- | ------------------------------------------------------ |
| `validate-async-operation`          | `validateAsyncOperationFromFolders` | `src/validate-async-operation-logic.ts`                |
| `validate-async-operation-and-load` | `validateAsyncOperationAndLoadToDb` | `src/validate-async-operation-logic-and-load-to-db.ts` |

## Goals

- Validate that every async operation-logic module exports its named function,
  routed by `fsmLanguage` (`typescript`/`python`/`rust`/`go`).
- Load validated actor metadata into PostgreSQL so the `asyncOperationlet` can
  spawn one process per actor queue.
- Fail loudly (and skip the DB load) when any async module is missing or does
  not export its function.

## Non-goals

- Scaffolding the actor stubs (PRD-002).
- Sync operation logic — actions/guards/delays (PRD-005).
- Running actors — the `asyncOperationlet` / promise worker stage.

## Requirements

### R1 — Validate async modules per `fsmLanguage`

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-async-operation \
  -f apps/fsm-core-example/sharedFSM \
  -w sharedPromise
```

`validateAsyncOperationFromFolder` extracts actor refs via
`extractFsmPluginRefs` and for each actor calls the appropriate language runtime
to verify the named function is defined in the actor file:

| Language     | Checker script             | Runtime invoked                                          |
| ------------ | -------------------------- | -------------------------------------------------------- |
| `typescript` | `src/checkers/check_fn.ts` | `deno run --allow-all check_fn.ts <file> <fn>`           |
| `python`     | `src/checkers/check_fn.py` | `python3 check_fn.py <file> <fn>`                        |
| `go`         | `src/checkers/check_fn.go` | compiled once with `go build`, binary cached per process |
| `rust`       | `src/checkers/check_fn.rs` | compiled once with `rustc`, binary cached per process    |

Each checker script exits 0 if the function is found, 1 if not, 2 on bad
arguments or parse/import error. For Rust, the binary is compiled on first use
and reused for subsequent actors in the same process.

Actors with an unsupported `fsmLanguage` are skipped with a warning.

**Status:** ✅ Implemented — `validateAsyncOperationFromFolders` /
`validateAsyncOperationFromFolder` (`src/validate-async-operation-logic.ts`),
wired to the `validate-async-operation` command.

### R1a — Language filter (`--lang`)

```bash
# Validate TypeScript actors only
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-async-operation \
  -f apps/fsm-core-example/sharedFSM \
  -w sharedPromise \
  --lang typescript

# Multiple languages
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-async-operation \
  -f apps/fsm-core-example/sharedFSM \
  -w sharedPromise \
  --lang typescript,python
```

The `--lang` flag (comma-separated) restricts which `fsmLanguage` actors are
validated. Omit `--lang` to validate all languages present. Applies to both
`validate-async-operation` and `validate-async-operation-and-load`.

**Status:** ✅ Implemented — `langs: OperationLang[] = []` parameter on both
`validateAsyncOperationFromFolders` and `validateAsyncOperationAndLoadToDb`;
wired to the `--lang` CLI flag.

### R2 — Validate and load to PostgreSQL

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c validate-async-operation-and-load \
  -f apps/fsm-core-example/sharedFSM \
  -w sharedPromise \
  --db-url postgresql://user:pass@localhost:5432/db
```

For each versioned folder, validate the async operation logic, then — when
verified — load its metadata (actor name, version, language, queue) into
PostgreSQL. `--db-url` overrides the `DATABASE_URL` env var.

**Status:** ⚠️ Partial — `validateAsyncOperationAndLoadToDb`
(`src/validate-async-operation-logic-and-load-to-db.ts`) currently validates
that each `sharedPromise` versioned folder exports the module name as a function
and returns the results **without any DB load**. It does not yet reuse the
per-`fsmLanguage` actor validation from R1, nor persist actor metadata. See
[Gaps](#gaps) #1 and #2.

### R3 — Shape (arity) validation

Validation confirms each name is a `function` via `typeof` but does **not**
check its arity or signature, so an actor whose stub signature does not match
the worker's `(input) => Promise<output>` calling convention (PRD-002, gap 1)
still passes. See [Gaps](#gaps) #3.

## Gaps

Tracked in [TODO.md](../todo/TODO.md):

1. **No DB load in `validate-async-operation-and-load`** —
   `validateAsyncOperationAndLoadToDb` validates and returns results but never
   persists actor metadata. Wire the load of actor name/version/language/queue
   into PostgreSQL (the store the `asyncOperationlet` reads from).
2. **Validates `sharedPromise` modules, not per-`fsmLanguage` actors** — the
   validate-async-operation-and-load path checks only the `sharedPromise`
   dependency export, not each invoke's actor per its `fsmLanguage`. Reuse
   `validateAsyncOperationFromFolder` so the loaded metadata matches what was
   validated.
3. **`typeof`-only validation** — no arity/signature check, so actor stubs with
   the wrong signature (PRD-002, gap 1) still validate. Validate the
   `(input) => Promise` shape, not just that the export is a function.

## Acceptance criteria

- `validate-async-operation` reports, per actor, whether its `fsmLanguage`
  module exports the named function. ✅
- Each language's runtime is called to confirm function presence — not just file
  existence. ✅ (`deno run` / `python3` / `go build` → binary / `rustc` →
  binary)
- `--lang` restricts which languages are validated; omitting it validates all.
  ✅
- `validate-async-operation-and-load` persists validated actor metadata into
  PostgreSQL. ❌ pending gap 1.
- The validate-async-operation-and-load path validates each invoke's actor per
  `fsmLanguage` (not just `sharedPromise` modules). ❌ pending gap 2.
- Actors that fail validation are excluded from the DB load. ❌ pending gaps
  1–2.
