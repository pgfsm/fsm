# fsm-compiler-ts — FSM Compiler

Validates FSM JSON definitions and generates the TypeScript plugin artifacts
(actions, guards, delays, actors stubs) that workers load at startup. Runs on
Deno.

## What it does

**Input:** an `fsm.json` file in a versioned FSM folder\
**Output:** a validated plugin — confirmed that every action, guard, delay, and
actor referenced in the JSON has a matching TypeScript export

Unresolved references are reported as errors so they're caught before
deployment, not at runtime.

## How to run

```bash
# Interactive CLI (dev mode with file watching)
deno run --allow-all --watch src/main.ts

# One-shot validation + generation
deno run --allow-all src/main.ts
```

## Key exports

```typescript
import {
  validateAndLoadFsmFromFolders, // validate all FSMs in a folder tree, then load if valid
  validateAndLoadPromiseFromFolders, // validate all promise actors in a folder tree, then load if valid
  validateFsmPluginLoadFromFolder, // validate one specific FSM plugin
} from "@pgfsm/compiler";

import type { WorkflowType } from "@pgfsm/compiler";
// WorkflowType = "fsm" | "sharedFsm" | "sharedPromise" | "promise"
```

The REST API and workers use these at startup to discover and validate FSM
plugins before accepting requests.

## Plugin structure

After running the compiler against an FSM definition, the version folder
contains:

```
fsm/<name>/v01/
  fsm.json
  xstate-fsm.json
  typescript/
    actions/index.ts   ← one export per action name in fsm.json
    guards/index.ts    ← one export per guard name
    delays/index.ts    ← one export per delay name
    actors/index.ts    ← one export per actor src
```

Generated stubs have `// TODO: implement` bodies — fill them in before running a
worker against the FSM.

## Reference

- [FSM definition format](./docs/fsm-definition-format.md) — full spec for
  `fsm.json` (states, transitions, guards, actions, actors, delays)

## Tests

```bash
deno test
```

## Deno version

Managed by `.prototools`. Install with:

```bash
proto install deno --pin local
```
