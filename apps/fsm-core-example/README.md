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

# In test-apps/debug-only/ (a @pgfsm/cli project generated from this fsm/ — see its README):
sync-worker/typescript/<fsmName>/<vNN>/{actions,guards,delays}/<name>/<name>.ts
async-worker/<lang>/<fsmName>/<vNN>/actors/          ← one subtree per language used
```

Version folders (`v01`, `v02`, …) are immutable once deployed. Increment to
create a new version; existing FSM instances keep running against their original
version.

Neither sync operation logic (actions/guards/delays) nor actor implementations
live in this app. They're in
[`test-apps/debug-only/`](../../test-apps/debug-only/README.md), generated from
this `fsm/` by `@pgfsm/cli`.

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
2. Generate its stubs into `test-apps/debug-only/` (from that directory):
   ```bash
   npm run fsm:add -- ../../apps/fsm-core-example/fsm/<yourAsyncOperationName>/v01/fsm.json -N <yourAsyncOperationName> -V v01
   ```
3. Implement the generated stubs under `test-apps/debug-only/sync-worker/` and
   `test-apps/debug-only/async-worker/`
4. Restart the server — it picks up the new FSM at startup
