# fsm-core-worker-ts — Queue Workers

Queue-consuming workers that drive FSM execution. Two worker types: one for full FSMs (`fsmworker`) and one for async actors (`fsmpromiseworker`).

## What it does

- **FSM worker** — polls a pgmq queue, processes incoming events (macrostep), and archives the result back to PostgreSQL
- **Promise worker** — picks up a queued actor invocation, runs the async function, and sends the result back to the parent FSM queue

## Key concepts

**Macrostep**: one full processing cycle — dequeue message, run all triggered transitions (microsteps inside PG), execute side effects (actions/guards), save state, archive message.

**Promise worker**: executes a single actor function, then sends `xstate.done.actor.*` or `xstate.error.actor.*` back to the parent FSM queue.

## Architecture

```
HTTP Routes (apps/fsm-core-ts-hono-deno)
  POST /fsm                   → createAndStartFSMWorker()
  POST /fsm/start             → startFSMWorkerWithDBLock()
  POST /fsm/stop              → controller.abort()
  POST /fsmpromise/start      → startFSMPromiseWorker()
  POST /fsmpromise/create-and-start → createAndStartPromiseWorker()
  POST /fsmpromise/stop       → controller.abort()
        ↓
Worker functions (this package — apps/fsm-core-worker-ts)
  startFSMWorkerWithDBLock()  → lockFsmInstance() + polling loop
  macrostepV2()               → readMessage() + microstep() + archiveEvent()
  processFSMPromiseQueueMessage() → actorFn() + sendEventToFsmQueue()
        ↓
DB layer (packages/fsm-core-db-ts)
  pgmq queue per FSM instance
  microstep runs inside PostgreSQL
  advisory lock prevents duplicate workers
```

## Key files

| File | Purpose |
|---|---|
| `src/fsmworker.ts` | `startFSMWorker()` — polling loop |
| `src/fsmworker-lock.ts` | `startFSMWorkerWithDBLock()` — acquires PG advisory lock |
| `src/fsmworker-helper.ts` | `macrostepV2()` — orchestrates one full processing cycle |
| `src/create-and-start-fsm-worker.ts` | `createAndStartFSMWorker()` — creates instance + starts worker |
| `src/fsmpromiseworker.ts` | `startFSMPromiseWorker()` — promise worker polling loop |
| `src/fsmpromiseworker-helper.ts` | `processFSMPromiseQueueMessage()` — runs one actor invocation |
| `src/create-and-start-promise-worker.ts` | `createAndStartPromiseWorker()` — creates queue + starts promise worker |
| `src/types.ts` | `FsmQueueMessage` — derived from DB composite type `fsm_queue_msg_data_v2` |
| `src/cli/index.ts` | CLI entry point — 5 commands for standalone use |

## Exports

```typescript
// Worker start functions
import {
  startFSMWorker,
  startFSMWorkerWithDBLock,
  createAndStartFSMWorker,
} from "@pgfsm/worker";

import {
  startFSMPromiseWorker,
  createAndStartPromiseWorker,
} from "@pgfsm/worker";

// Core processing
import {
  macrostepV2,
  runActionImplementation,
  splitByEventTypes,
  splitBySendEventName,
} from "@pgfsm/worker";

import { processFSMPromiseQueueMessage } from "@pgfsm/worker";

// Types
import type {
  FsmQueueMessage,
  FsmQueueMessageEventData,
  FSMPromiseArchiveData,
  FsmModuleDefinition,
  VerifiedModule,
} from "@pgfsm/worker";
```

- `startFSMWorkerWithDBLock` — starts a worker and holds a PG advisory lock for the duration (production use)
- `startFSMWorker` — starts a worker without a lock (development/testing only)
- `createAndStartFSMWorker` — creates a new FSM instance + PGMQ queue, then starts worker with lock
- `createAndStartPromiseWorker` — creates a PGMQ queue + starts promise worker
- `macrostepV2` — runs one complete FSM processing cycle (dequeue → transitions → side effects → archive)

## Message format

`FsmQueueMessage` is derived directly from the DB composite type `fsm_queue_msg_data_v2`:

```typescript
type FsmQueueMessage = {
  eventData: {
    eventType: string | null;       // transition trigger name
    eventPayload: Json | null;      // arbitrary payload
    actionType: string | null;      // e.g. "childFsm_completed", "delay"
  } | null;
  queueId: string | null;           // this instance's UUID
  queueType: string | null;
  queueVersion: string | null;
  sendToParentQueueId: string | null;         // parent FSM queue UUID (or sentinel)
  sendToParentQueueType: string | null;
  sendToParentQueueIdEventName: string | null; // event name to send parent on completion
  queueMsgId: number | null;
  queueMsgDelay: number | null;
  queueFnName: string | null;
}
```

## CLI

Five commands for running workers standalone (without the HTTP API):

```bash
deno task cli -c start-worker-with-db-lock -q <queue> -n <fsm-name> -v <version> -f <abs-folder-path>
deno task cli -c create-and-start-worker   -n <fsm-name> -v <version> -f <abs-folder-path>
deno task cli -c start-promise-worker      -q <queue> -t <type> -n <fsm-name> -v <version> -f <abs-folder-path>
```

See [CLI-USAGE.md](./CLI-USAGE.md) for the complete reference (all flags, graceful shutdown, exit codes, HTTP equivalents).
