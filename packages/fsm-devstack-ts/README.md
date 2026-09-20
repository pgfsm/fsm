# @pgfsm/devstack

A process spawn/signal supervision primitive: spawn a group of child processes,
forward `SIGINT`/`SIGTERM` to all of them on shutdown, and fail fast — tearing
down the rest — if any one of them exits on its own first. It backs `fsmdev`,
the local FSM dev-stack launcher in the
[pgfsm/fsm](https://github.com/pgfsm/fsm) monorepo (`generate-all` → `pgcron` →
the Activity Gateway + generated worker SDK + `fsmlet`, spawned and supervised
together).

**No CLI ships in this package yet.** `fsmdev` currently only runs from source
inside that monorepo
(`deno run --allow-all
packages/fsm-devstack-ts/src/cli/fsmdev.ts`) — it locates
its sibling CLIs via monorepo-relative paths and shells out to `deno run`
directly, neither of which is meaningful outside that workspace. Making `fsmdev`
itself installable and runnable via `npx` is tracked upstream; this package only
publishes the supervision primitive below until that lands.

## Install

```bash
npm install @pgfsm/devstack
```

## Usage

```typescript
import { runSupervised } from "@pgfsm/devstack";
import type { ProcessSpec } from "@pgfsm/devstack";

const specs: ProcessSpec[] = [
  {
    name: "gateway",
    cmd: "async-operation-worker-gateway",
    args: ["--bind", "unix:/tmp/gateway.sock"],
  },
  {
    name: "fsmlet",
    cmd: "fsmlet",
    args: ["-f", "./fsm", "-d", process.env.DATABASE_URL!],
  },
];

// Spawns both, forwards SIGINT/SIGTERM to both on shutdown, and — if either
// one exits on its own first — tears down the other and resolves non-zero.
const exitCode = await runSupervised(specs);
process.exit(exitCode);
```

For finer control over what triggers shutdown (e.g. driving it from something
other than real OS signals, as this package's own tests do), use
`runProcessGroup(specs, shutdownSignal)` directly — the same logic
`runSupervised` wraps, taking a `Promise<SupervisorSignal>` instead of listening
for OS signals itself.

## Programmatic usage

```typescript
import {
  runProcessGroup, // core spawn/race logic; caller supplies the shutdown trigger
  runSupervised, // spawns + listens for real SIGINT/SIGTERM itself
} from "@pgfsm/devstack";

import type {
  ProcessSpec,
  RunSupervisedOptions,
  SupervisorSignal, // "SIGINT" | "SIGTERM"
} from "@pgfsm/devstack";
```

## License

Apache-2.0
