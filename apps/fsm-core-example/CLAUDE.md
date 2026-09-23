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
- Per-language actor implementations, one subdirectory per language:
  `typescript/actors/`, `python/actors/`, `rust/actors/`, `go/actors/` — the
  concrete example of the polyglot actor model described in the root `CLAUDE.md`

`vitalsWorkflow/` is a reusable sub-workflow (asyncOperationType `fsm`) invoked
by other FSMs, rather than a standalone top-level FSM — otherwise it follows the
same layout. Definitions target **XState 5** semantics and are consumed by
`packages/fsm-compiler-ts/`.

Sync operation logic (actions/guards/delays) is **not** colocated with its FSM —
`generate-sync-logic` always writes to `Deno.cwd()`, independent of `--folder`'s
own location. Running it from this app's own root (`apps/fsm-core-example/`)
lands output at
`sync-worker/typescript/<fsmName>/<fsmVersion>/{actions,guards,delays}/` — a
sibling of `fsm/`, matching where `worker-sdk-generated/` sits — plus
`generated-sync-operation-registry.ts` and a copy of that version's `fsm.json`
at the same `<fsmName>/<fsmVersion>` level.
