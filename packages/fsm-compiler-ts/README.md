# fsm-compiler-ts — FSM Compiler

Validates FSM JSON definitions and generates polyglot plugin artifacts (actions,
guards, delays, actor stubs) that workers load at startup. Runs on Deno.

## What it does

**Input:** an `fsm.json` file in a versioned FSM folder\
**Output:** a validated plugin — confirmed that every action, guard, delay, and
actor referenced in the JSON has a matching export in its declared language

Each actor is validated by calling its language's runtime directly:

| Language     | Runtime called                               |
| ------------ | -------------------------------------------- |
| `typescript` | `deno run src/checkers/check_fn.ts`          |
| `python`     | `python3 src/checkers/check_fn.py`           |
| `go`         | `go build src/checkers/check_fn.go` → binary |
| `rust`       | `rustc src/checkers/check_fn.rs` → binary    |

Unresolved references are reported as errors so they're caught before
deployment, not at runtime.

## How to run

```bash
# Interactive CLI (dev mode with file watching)
deno run --allow-all --watch src/main.ts

# One-shot validation + generation
deno run --allow-all src/main.ts
```

## Prerequisites

- **Deno** (see `.prototools` for pinned version) — always required
- **Python 3** (`python3` on `PATH`) — required when validating `python` actors
- **Go** (`go` on `PATH`) — required when validating `go` actors
- **Rust** (`rustc` on `PATH`) — required when validating `rust` actors

## Key exports

```typescript
import {
  validateAndLoadFsmFromFolders, // validate all FSMs in a folder tree, then load if valid
  validateAndLoadPromiseFromFolders, // validate all promise actors in a folder tree, then load if valid
  validateAsyncOperationFromFolders, // validate actor exports per fsmLanguage, optionally filtered by lang
  validateFsmPluginLoadFromFolder, // validate one specific FSM plugin
} from "@pgfsm/compiler";

import type { OperationLang, WorkflowType } from "@pgfsm/compiler";
// WorkflowType  = "fsm" | "sharedFsm" | "sharedPromise" | "promise"
// OperationLang = "typescript" | "python" | "rust" | "go"
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
    actions/index.ts              ← one export per action name in fsm.json
    guards/index.ts               ← one export per guard name
    delays/index.ts               ← one export per delay name
    actors/promise_v01_<src>.ts   ← one file per actor, one export named <src>
  python/
    actors/promise_v01_<src>.py
  rust/
    actors/promise_v01_<src>.rs
  go/
    actors/promise_v01_<src>.go
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
