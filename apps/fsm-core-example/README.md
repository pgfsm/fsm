# fsm-core-example — Example FSM Definitions

Reference FSM definitions used for development and testing. Each FSM is a self-contained folder with a JSON definition and TypeScript implementations of its actions, guards, delays, and actors.

## What's here

| FSM | Path | Description |
|---|---|---|
| `creditCheck` | `fsm/creditCheck/` | Credit verification flow — parallel credit agency checks, actor invocations |
| `carVitals` | `fsm/carVitals/` | Vehicle diagnostics state machine |
| `taskMachineConfig` | `fsm/taskMachineConfig/` | Generic task workflow |

Shared actors and FSMs live in `actors/`, `actions/`, `guards/`, `delays/`, and `sharedFSM/` at the root of this app.

## Folder structure

Each FSM follows this layout:

```
fsm/<fsmName>/
  v01/
    fsm.json              ← FSM definition (input to compiler)
    xstate-fsm.json       ← XState 5-compatible rendering
    typescript/
      actions/index.ts    ← action implementations
      guards/index.ts     ← guard implementations
      delays/index.ts     ← delay implementations
      actors/index.ts     ← actor implementations
  v02/                    ← new version; v01 is untouched
    ...
```

Version folders (`v01`, `v02`, …) are immutable once deployed. Increment to create a new version; existing FSM instances keep running against their original version.

## How to run the example server

```bash
deno run --allow-all --env-file=.env --watch main.ts
```

This starts a server that mounts all FSMs in this folder as plugin roots. See the root [README](../../README.md) for the full quick-start flow including database setup.

## Adding a new FSM

1. Create `fsm/<yourFsmName>/v01/fsm.json` (see [FSM definition format](../../docs/fsm-definition-format.md))
2. Run the compiler to generate the TypeScript scaffold:
   ```bash
   cd packages/fsm-compiler-ts && deno run --allow-all src/main.ts
   ```
3. Implement the generated stubs in `typescript/actions/`, `guards/`, `delays/`, `actors/`
4. Restart the server — it picks up the new FSM at startup
