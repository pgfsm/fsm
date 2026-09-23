# CLAUDE.md — FSM Examples (`apps/fsm-core-example/`)

Scoped guidance for example FSM definitions. Repo-wide conventions and session
protocol live in the root `CLAUDE.md` / `AGENTS.md`.

## FSM Definition Format

FSMs are versioned JSON files in `apps/fsm-core-example/fsm/` (e.g.
`creditCheck/`, `carVitals/`, `taskMachineConfig/`, `vitalsWorkflow/`). Each
version folder (`v01/`, `v02/`) contains:

- `fsm.json` — state machine definition
- `xstate-fsm.json` — XState 5-compatible format
- `machine.ts` / `machine-with-provider.ts` — XState machine definitions

`vitalsWorkflow/` is a reusable sub-workflow (asyncOperationType `fsm`) invoked
by other FSMs, rather than a standalone top-level FSM — otherwise it follows the
same layout. Definitions target **XState 5** semantics and are consumed by
`packages/fsm-compiler-ts/`.

Neither sync operation logic (actions/guards/delays) nor actor implementations
are colocated with their FSM's own version folder — `generate-sync-logic` and
`generate-async-logic` both always write to `Deno.cwd()`, independent of
`--folder`'s own location (#305/#307). Running either from this app's own root
(`apps/fsm-core-example/`) lands output at, respectively:

- `sync-worker/typescript/<fsmName>/<fsmVersion>/{actions,guards,delays}/` —
  plus `generated-sync-operation-registry.ts` and a copy of that version's
  `fsm.json`, both at the same `<fsmName>/<fsmVersion>` level
- `async-worker/<lang>/<fsmName>/<fsmVersion>/actors/` — one subtree per
  language actually used by that version's `invoke` objects (`typescript`,
  `python`, `rust`, `go`), plus that language's aggregate worker SDK (`cli.ts`,
  `sdk.ts`, `<lang>-actors-registry.generated.ts`, etc.) at
  `async-worker/<lang>/`

Both are siblings of `fsm/` at this app's own root, not nested inside each
`fsm/<asyncOperationName>/<version>/` folder.
