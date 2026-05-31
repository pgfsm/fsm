# fsm-core-worker-ts — Queue Workers

Queue-consuming workers that drive FSM execution. Two worker types: one for full FSMs (`fsmworker`) and one for async actors (`fsmpromiseworker`).

## What it does

- **FSM worker** — polls a pgmq queue, processes incoming events (macrostep), and archives the result back to PostgreSQL
- **Promise worker** — picks up a queued actor invocation, runs the async function, and sends the result back to the parent FSM queue

Workers are started via the REST API (`POST /fsm/fsmworker`, `POST /fsm/fsmpromise`) or programmatically. Each worker is tied to one queue (one FSM instance or one promise actor).

## Key concepts

**Macrostep**: one full processing cycle — dequeue message, run all triggered transitions (microsteps inside PG), execute side effects (actions/guards), save state, archive message.

**Promise worker**: executes a single actor function, then sends `xstate.done.actor.*` or `xstate.error.actor.*` back to the parent FSM queue.

## Key files

| File | Purpose |
|---|---|
| `src/fsmworker.ts` | FSM worker entry point — `startFSMWorker()` |
| `src/fsmworker-helper.ts` | `macrostepV2()` — orchestrates one full processing cycle |
| `src/fsmpromiseworker-helper.ts` | `processFSMPromiseQueueMessage()` — runs one actor invocation |
| `src/types.ts` | `FsmQueueMessage` shape — the pgmq message payload |

## Exports

```typescript
import { startFSMWorker, startFSMWorkerWithDBLock } from "@pgfsm/worker";
import { createAndStartPromiseWorker } from "@pgfsm/worker";
```

- `startFSMWorkerWithDBLock` — starts a worker and holds a PG advisory lock for the duration
- `createAndStartPromiseWorker` — creates a pgmq queue and starts a promise worker

## Message format (`FsmQueueMessage`)

```typescript
{
  event_data: {
    event_type: string;      // transition trigger name
    event_payload: Json;     // arbitrary payload
    action_type: string;     // e.g. "childFsm_completed", "delay"
  };
  queue_id: string;          // this instance's UUID
  queue_type: string | null;
  queue_version: string | null;
  send_to_parent_queue_id: string | null;   // parent FSM queue UUID, or sentinel
  send_to_parent_queue_type: string | null;
  send_to_parent_queue_id_event_name: string; // event name to send parent on completion
}
```
