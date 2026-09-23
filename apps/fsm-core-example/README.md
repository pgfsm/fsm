# fsm-core-example — Example FSM Definitions

Reference FSM definitions used for development and testing. Each FSM is a
self-contained folder with a JSON definition and TypeScript implementations of
its actions, guards, delays, and actors.

## What's here

| FSM                 | Path                     | Description                                                                 |
| ------------------- | ------------------------ | --------------------------------------------------------------------------- |
| `creditCheck`       | `fsm/creditCheck/`       | Credit verification flow — parallel credit agency checks, actor invocations |
| `carVitals`         | `fsm/carVitals/`         | Vehicle diagnostics state machine                                           |
| `taskMachineConfig` | `fsm/taskMachineConfig/` | Generic task workflow                                                       |
| `vitalsWorkflow`    | `fsm/vitalsWorkflow/`    | Reusable sub-workflow (asyncOperationType `fsm`) invoked by other FSMs      |

Shared actors live in `actors/`, `actions/`, `guards/`, `delays/` at the root of
this app; shared, reusable FSMs (like `vitalsWorkflow`) live alongside the
top-level FSMs under `fsm/`.

## Folder structure

Each FSM follows this layout:

```
fsm/<asyncOperationName>/
  v01/
    fsm.json              ← FSM definition (input to compiler)
    xstate-fsm.json       ← XState 5-compatible rendering
    typescript/
      actors/index.ts     ← actor implementations
  v02/                    ← new version; v01 is untouched
    ...
sync-worker/
  typescript/
    <asyncOperationName>/
      v01/
        actions/index.ts                     ← action implementations
        guards/index.ts                      ← guard implementations
        delays/index.ts                      ← delay implementations
        generated-sync-operation-registry.ts ← combined registry (generate-sync-logic output)
        fsm.json                             ← copy of that version's fsm.json
      v02/
        ...
```

Version folders (`v01`, `v02`, …) are immutable once deployed. Increment to
create a new version; existing FSM instances keep running against their original
version.

Sync operation logic (actions/guards/delays) is not colocated with its FSM's own
version folder — `generate-sync-logic` always writes to `Deno.cwd()`, so
`sync-worker/` sits at this app's own root (a sibling of `fsm/`, run from here),
not nested inside each `fsm/<asyncOperationName>/<version>/` folder.

## How to run the example server

```bash
deno run --allow-all --env-file=.env --watch main.ts
```

This starts a server that mounts all FSMs in this folder as plugin roots. See
the root [DEVELOPER.md](../../DEVELOPER.md) for the full quick-start flow
including database setup.

## Running the DB-backed tests

The `*-test.ts` files under each FSM's version folder (e.g.
`fsm/creditCheck/v01/compare-fsm-core-macrostep-v2-with-xstate-transition-test.ts`)
exercise real DB functions (`macrostepV2`, `resolveStateValue`, worker journeys)
against a live Postgres connection and compare the result to the FSM's own
XState machine. They need that FSM already loaded into
`fsm_core.fsm_states`/`fsm_transitions` — run this once per fresh/reset DB:

```bash
deno task load   # from this directory, or `deno task -f fsm-core-example load` from the repo root
```

Skipping this step doesn't fail loudly — the tests just get `undefined` back
from DB calls and fail on unrelated-looking assertions.

## Adding a new FSM

1. Create `fsm/<yourAsyncOperationName>/v01/fsm.json` (see
   [FSM definition format](../../packages/fsm-compiler-ts/docs/fsm-definition-format.md))
2. Run the compiler to generate the TypeScript scaffold:
   ```bash
   cd packages/fsm-compiler-ts && deno run --allow-all src/main.ts
   ```
3. Implement the generated stubs in
   `sync-worker/typescript/<yourAsyncOperationName>/v01/actions/`, `guards/`,
   `delays/` (run `generate-sync-logic` from this directory so it lands here),
   and `fsm/<yourAsyncOperationName>/v01/typescript/actors/`
4. Restart the server — it picks up the new FSM at startup
