# PRD — Design your FSM JSON schema

**Package:** `@pgfsm/compiler` (`packages/fsm-compiler-ts`) **Status:**
Partially implemented — see [Gaps](#gaps) and [TODO.md](../todo/TODO.md).

## Summary

The first stage of the FSM lifecycle is **designing the state machine**: turning
a workflow into a versioned `fsm.json` that PostgreSQL can load and execute. The
compiler is responsible for producing and validating that `fsm.json`. This PRD
captures the two authoring paths and the shape of the definition, derived from
§1 of the root [`README.md`](../../../../README.md).

## Background

An FSM is a JSON file (`fsm.json`) in a versioned folder (e.g.
`creditCheck/v01/`). It is the normalized form loaded into PostgreSQL; an
`xstate-fsm.json` (XState 5-compatible) is emitted alongside it for tooling. The
canonical schema is
[`fsm.machine.schema.v3.json`](../../../database-src/fsm.machine.schema.v3.json).

See the [FSM Definition Format](../reference/fsm-definition-format.md) reference
for the full field-by-field spec.

## Goals

- Let a developer produce a valid `fsm.json` (+ `xstate-fsm.json`) from either
  an XState machine or a hand-authored schema.
- Keep PostgreSQL the source of truth: the compiler's output is what gets
  loaded.
- Support versioned, immutable definitions (a new folder per revision).

## Non-goals

- Executing the machine (that is the `fsmlet` / worker stage).
- Generating operation-logic implementations (that is the scaffolding stage —
  `generate-async-logic` / `generate-sync-logic`).

## Requirements

### R1 — Author from an existing XState machine (1.a)

Given a `machine.ts` authored with XState 5's `createMachine()`, the compiler
emits `fsm.json` + `xstate-fsm.json`.

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate \
  -f apps/fsm-core-example/fsm/creditCheck/v01/machine.ts
```

- Accepts a single `.ts` file (version derived from the parent folder name) or a
  directory (walks every versioned subdirectory).
- `--show-recommendation` validates the generated `fsm.json` against the schema
  and prints issues.

**Status:** ✅ Implemented — `generateFsmJSONFromMachineFile` /
`generateFsmJSONFromFolders` (`src/generate-fsm-json.ts`), wired to the
`generate` command in `src/cli/index.ts`.

### R2 — Author from scratch (1.b)

A developer hand-authors `fsm.json` directly against the schema (no XState
source) and validates it with any JSON Schema validator:

```bash
npx ajv-cli validate \
  -s packages/database-src/fsm.machine.schema.v3.json \
  -d apps/fsm-core-example/fsm/creditCheck/v01/fsm.json
```

**Status:** ✅ Works via external `ajv-cli`. The compiler has no first-class
schema-only validate command (see [Gaps](#gaps)).

### R3 — The `invoke` object

Each state may declare async operation logic via an `invoke` array. Each entry
carries:

| Field         | Required | Meaning                                                      |
| ------------- | -------- | ------------------------------------------------------------ |
| `type`        | yes      | `xstate.invoke`                                              |
| `id`          | yes      | Instance id of the invocation                                |
| `src`         | yes      | Actor name — the exported fn in its `<lang>/actors/` file    |
| `fsmType`     | yes      | `promise \| sharedPromise \| sharedFsm \| fsm`               |
| `fsmVersion`  | yes      | Version of the invoked service                               |
| `fsmLanguage` | no       | `typescript \| python \| rust \| llm` (default `typescript`) |

`fsmType`/`fsmVersion`/`fsmLanguage` are backfilled when missing by
`addMissingFsmTypeToInvokeActors` (`src/generate-fsm-json.ts`); `fsmLanguage`
defaults to `typescript`. `fsmLanguage` selects which language's actor folder
implements the operation logic — the routing key for the polyglot model.

**Status:** ✅ Implemented — `fsmType`/`fsmVersion`/`fsmLanguage` are backfilled
and `extractFsmPluginRefs` parses `fsmLanguage` onto `ActorReference`. The
compiler now validates against schema v3. (Language-keyed _scaffolding_ that
acts on `fsmLanguage` remains a separate PRD-002 gap.)

### R4 — Versioning

Definitions live in versioned sub-folders (`v01`, `v02`, …), immutable once
deployed. Existing instances keep running against their creation version.

**Status:** ✅ Implemented — versioned folder walking in the `generate` command.

## Gaps

Tracked in [TODO.md](../todo/TODO.md):

1. ✅ **Schema version drift (resolved)** — the compiler now validates against
   `fsm.machine.schema.v3.json` in all three call sites.
2. ✅ **`fsmLanguage` wired (resolved)** — parsed onto `ActorReference`,
   backfilled with a `typescript` default, and carried into plugin generation.
3. ✅ **Language-keyed scaffolding (resolved)** — actors are generated per
   `fsmLanguage` (`generate-async-logic`) and sync logic per `--lang`
   (`generate-sync-logic`); `typescript`/`python`/`rust`/`go` (PRD-002,
   PRD-003).
4. **No native schema-validate command** — R2 depends on external `ajv-cli`; a
   `-c validate-schema` command would let the compiler own the authoring loop.

## Acceptance criteria

- `generate` produces schema-valid `fsm.json` + `xstate-fsm.json` from a
  `machine.ts` or folder. ✅
- A hand-authored `fsm.json` validates against `fsm.machine.schema.v3.json`. ✅
  (external tool)
- Every `invoke` object resolves `type`, `id`, `src`, `fsmType`, `fsmVersion`,
  and `fsmLanguage` (defaulted). ✅
- Compiler validation targets the same schema version the docs reference. ✅
