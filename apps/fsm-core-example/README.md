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
apps/fsm-core-example/fsm/<asyncOperationName>/
  v01/
    fsm.json              ← FSM definition (input to compiler)
    xstate-fsm.json       ← XState 5-compatible rendering
  v02/                    ← new version; v01 is untouched
    ...

# At the apps/ level (siblings of fsm-core-example/, not of this app's own fsm/ — see below):
apps/sync-worker/
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
apps/async-worker/
  deno.json               ← scoped import map (workspace member) — see CLAUDE.md
  <lang>/                 ← one subtree per language actually used (typescript/python/rust/go)
    cli.ts, sdk.ts, <lang>-actors-registry.generated.ts, ...  ← aggregate worker SDK
    <asyncOperationName>/
      v01/
        actors/index.ts   ← actor implementations
        actors-manifest.json
      v02/
        ...
```

Version folders (`v01`, `v02`, …) are immutable once deployed. Increment to
create a new version; existing FSM instances keep running against their original
version.

Neither sync operation logic (actions/guards/delays) nor actor implementations
are colocated with their FSM's own version folder — `generate-sync-logic` and
`generate-async-logic` both always write to `Deno.cwd()`. As of #316, run both
from **`apps/`** (not this app's own directory) — `sync-worker/` and
`async-worker/` land there, siblings of `apps/fsm-core-example/`, not of this
app's own `fsm/`. This also matches what `fsmlet` resolves at runtime — see the
root `DEVELOPER.md`.

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
   `../sync-worker/typescript/<yourAsyncOperationName>/v01/actions/`, `guards/`,
   `delays/` and
   `../async-worker/typescript/<yourAsyncOperationName>/v01/actors/` (run
   `generate-sync-logic`/`generate-async-logic` from `apps/`, not this
   directory, so they land there)
4. Restart the server — it picks up the new FSM at startup
