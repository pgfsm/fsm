# PRD-003 — Scaffold sync operation logic (actions / guards / delays)

**Package:** `@pgfsm/compiler` (`packages/fsm-compiler-ts`) **Status:**
Partially implemented — see [Gaps](#gaps) and [TODO.md](../todo/TODO.md).
**Related:**
[PRD-002 — Scaffold async operation logic](./prd-002-scaffold-async-operation-logic.md).

## Summary

Alongside the async actors (PRD-002), the compiler scaffolds **base (stub)
code** for the machine's **sync operation logic** — the `actions`, `guards`, and
`delays` referenced in `fsm.json`. This is stage 3 of the FSM lifecycle, derived
from §3 of the root [`README.md`](../../../../README.md). The
`generate-sync-logic` command emits all three, in the language(s) passed via
`--lang`. Unlike actors, this logic runs **inline inside a macrostep** of the
`fsmlet` — no separate queue or process.

## Background

- **Actions** — side effects run on state entry/exit and on transitions. An
  action may return a new context.
- **Guards** — boolean predicates on a transition's `cond`; a transition fires
  only when its guard returns truthy.
- **Delays** — return a duration in milliseconds used to schedule a delayed
  event.

Stubs are written per language into `<lang>/{actions,guards,delays}/` — the
`--lang` flag selects which of `typescript`, `python`, `rust`, `go` to generate.

## Goals

- Generate one stub per unique `action`, `guard`, and `delay` referenced in
  `fsm.json`.
- Emit stubs whose signature matches how the `fsmlet` worker actually invokes
  them.
- Support the language-keyed folder convention
  (`<lang>/{actions,guards,delays}/index.ts`).

## Non-goals

- Implementing the bodies (developer's job).
- Async actors (PRD-002).
- Running the machine — the `fsmlet` / worker stage.

## Requirements

### R1 — Generate stubs from `fsm.json`

```bash
deno run --allow-all packages/fsm-compiler-ts/src/cli/index.ts \
  -c generate-sync-logic \
  -f apps/fsm-core-example/fsm \
  --lang typescript,python
```

Walks every versioned folder, extracts action/guard/delay names via
`extractFsmPluginRefs`, and writes
`<lang>/{actions,guards,delays}/<index-module>` for each requested `--lang`
(default `typescript`). `xstate.raise` / `xstate.cancel` are skipped
(built-ins); delay stub names are prefixed with `delay`
(`DELAY_ACTION_NAME_PREFIX`).

**Status:** ✅ Implemented — `generateSyncOperationLogicFromFolders`
(`src/generate-sync-operation-logic.ts`) using shared templates in
`src/operation-logic-scaffold.ts`, wired to the `generate-sync-logic` command.

### R2 — Correct stub signatures

The `fsmlet` worker (`apps/fsm-core-worker-ts/src/fsmworker-helper.ts`) invokes
each kind as:

| Kind   | Worker call                                      | Contract                          |
| ------ | ------------------------------------------------ | --------------------------------- |
| action | `fn(current_context, action.params ?? {}, meta)` | returned value becomes context    |
| guard  | `fn(current_context, condObj, meta)`             | returns truthy → transition fires |
| delay  | `fn(...)`                                        | returns delay in milliseconds     |

So the generated stubs should be, e.g.:

```ts
// action
export function assignSSN(context: any, params: any, meta: any) {
  // TODO: implement — return the new context
  return context;
}
// guard
export function isValid(context: any, cond: any, meta: any): boolean {
  // TODO: implement
  return true;
}
// delay
export function delayRetry(context: any, event: any): number {
  // TODO: implement — return delay in ms
  return 5000;
}
```

**Status:** ⚠️ Partial. The generator emits:

- action → `<name>(context, event)` (arity 2, returns nothing). ❌ should be
  `(context, params, meta)` returning context.
- guard → `<name>(context, event) { return true; }` (arity 2). ❌ should be
  `(context, cond, meta)`.
- delay → `delay<name>(context, event): number { return 0; }`. ✅ now returns a
  number (in every language).

Validation (`validateSyncOperationFromFolder`) only checks that each name is a
`function` (via `typeof`), **not** its arity, so the remaining action/guard
mismatches still pass `validate-sync-operation`. See [Gaps](#gaps). Validation
and load of this operation logic is covered by
[PRD-005](./prd-005-validate-sync-operation-logic.md).

### R3 — Language-keyed scaffolding

The `--lang` flag selects which language folder(s) to generate:
`typescript | python | rust | go` (comma-separated; default `typescript`).

**Status:** ✅ Implemented — `generate-sync-logic --lang <langs>` writes
`actions`/`guards`/`delays` modules for each requested language.

## Gaps

Tracked in [TODO.md](../todo/TODO.md):

1. **Fix action stub signature** — emit `(context, params, meta)` and return the
   context, matching `fsmworker-helper.ts`
   (`fn(current_context, action.params,
   meta)` whose return becomes the new
   context). Current stub is `(context, event)` returning nothing.
2. ✅ **Delay stub returns a number (resolved)** — delay stubs now emit a
   numeric return in every language.
3. **Fix guard stub arity** — emit `(context, cond, meta)` to match
   `fn(current_context, condObj, meta)`; return type (`boolean`) is already
   correct.
4. **Idempotent regeneration** (shared with PRD-002) — `writeOperationModule`
   overwrites hand-written `actions`/`guards`/`delays` bodies. Language-keyed
   scaffolding is now resolved (`--lang`).

## Acceptance criteria

- `generate-sync-logic` produces one stub per unique action, guard, and delay.
  ✅
- Action stubs are `(context, params, meta)` and return context. ❌ pending
  gap 1.
- Delay stubs return a number (ms). ✅
- Guard stubs are `(context, cond, meta)` returning boolean. ❌ pending gap 3.
- Generated in the requested `--lang` language(s). ✅
- Re-running `generate-sync-logic` does not clobber implemented bodies. ❌
  pending gap 4.
