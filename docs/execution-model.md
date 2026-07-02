# Execution Model

How an event flows from the REST API through PostgreSQL and back.

<p align="center">
  <img src="../.github/assets/execution-model.svg" alt="Execution model: an event flows Client → REST API → PostgreSQL (pgmq.send) → instance queue; a worker dequeues it, runs a macrostep (resolve state, microstep_v2, run actions), archives the result (persist state, pgmq.archive, notify parent), and loops back to readMessage()." width="90%">
</p>

## Overview

```
Client
  │
  │  POST /fsm/fsm/send  { fsm_instance_id, event_data }
  ▼
REST API (fsm.handlers.ts)
  │
  │  sendEventToFsmQueueWithEventLogs()
  ▼
PostgreSQL: send_event_to_fsm_queue_with_event_logs_v2()
  │  — validates instance exists
  │  — writes event log row
  │  — calls pgmq.send() to enqueue the message
  │
  ▼  [message sits in queue]
  │
Worker (fsmworker.ts) — polling loop
  │
  │  readMessage() → pgmq.read()
  ▼
macrostepV2() — fsmworker-helper.ts
  │
  │  getFsmDataResolveStateValue()
  │  → get_fsm_data_resolve_state_value_v2()  — load current state from DB
  │
  │  microstep()
  │  → microstep_v2()  — evaluate which transitions fire for this event
  │    returns: new state, actions to run, queues to add/remove
  │
  │  runActionImplementation()  — execute entry/exit/transition actions
  │    (calls into typescript/actions/index.ts)
  │
  │  [collect schedule and promise queue changes]
  ▼
archiveEventFromFsmTypeWorker()
  → archive_event_from_fsm_type_worker_v2()
    │
    │  Step 1-2: remove expired schedule/promise queue entries
    │  Step 3-4: cancel removed actors (pgmq.archive on their queues)
    │  Step 5-6: enqueue new schedule/promise actors
    │             → send_event_to_fsm_queue_with_event_logs_v2()
    │             → send_event_to_queue_from_fsm_instance_id_v2()
    │  Step 7:   UPDATE fsm_instance (state, context, status, queue data)
    │  Step 8:   pgmq.archive() — remove processed message from queue
    │  Step 9:   if terminal status AND real parent queue →
    │              send_event_to_fsm_queue_with_event_logs_v2() to parent
    │
    ▼
  Done — worker loops back to readMessage()
```

## Step-by-step detail

### 1. Client sends event

```
POST /fsm/fsm/send
{
  "fsm_instance_id": "<uuid>",
  "event_data": { "type": "Submit" }
}
```

### 2. API enqueues the event — `send_event_to_fsm_queue_with_event_logs_v2`

PG function called with:

- `input_fsm_instance_id` — the instance UUID (also the queue name)
- `input_event_name` — the event type (`"Submit"`)
- `input_send_to_parent_queue_id` — sentinel UUID (`api_system_queue_uuid()`)
  for API-originated events

Writes an event log row and calls `pgmq.send()`. Returns immediately — the event
is now queued.

### 3. Worker dequeues — `pgmq.read`

The FSM worker polls the queue (visibility timeout: 30s). On receiving a
message, it reads the `FsmQueueMessage` payload.

### 4. Load current state — `get_fsm_data_resolve_state_value_v2`

Fetches the `fsm_instance` row and resolves the current XState state value from
the stored ltree path.

### 5. Evaluate transitions — `microstep_v2`

Called with the current state and incoming event name. Returns:

- The set of transitions that fire
- New target state value
- Actions to execute
- Schedule/promise queue mutations (add/remove)

### 6. Execute actions — `runActionImplementation`

The worker calls each action function from `typescript/actions/index.ts` in
sequence. Actions may modify context.

### 7. Archive macrostep — `archive_event_from_fsm_type_worker_v2`

One atomic PG function that:

1. Removes expired schedule queue entries from `total_schedule_queue_data`
2. Removes expired promise queue entries from `total_promise_queue_data`
3. Archives canceled schedule actors: `pgmq.archive()` on their queues
4. Cancels removed promise actors:
   `cancel_event_for_fsm_promise_type_worker_v2()`
5. Enqueues new schedule actors: `send_event_to_fsm_queue_with_event_logs_v2()`
   with delay
6. Enqueues new promise actors: `send_event_to_queue_from_fsm_instance_id_v2()`
7. `UPDATE fsm_instance` — persists new state, context, status, queue data
8. `pgmq.archive()` — removes the processed message from the current queue
9. If FSM reached a terminal status (`done`, `stopped`, `completed`, `final`)
   **and** `send_to_parent_queue_id` is a real queue (not a sentinel): sends
   `childFsm_completed` event to the parent queue

### 8. Parent notification (step 9 above)

When a child FSM completes, the parent receives an event named
`send_to_parent_queue_id_event_name` (carried on the original message). The
parent worker picks it up in its next poll and processes it as a normal event —
no special handling needed. The chain propagates naturally one hop at a time.

## Sentinel queue IDs

Two well-known UUIDs prevent the archive function from sending spurious parent
notifications:

| Sentinel                  | UUID                                   | Meaning                                               |
| ------------------------- | -------------------------------------- | ----------------------------------------------------- |
| `pg_system_queue_uuid()`  | `00000000-0000-0000-0000-000000000000` | Event originated inside PostgreSQL                    |
| `api_system_queue_uuid()` | `00000000-0000-0000-0000-000000000001` | Event originated from the REST API with no parent FSM |

If `send_to_parent_queue_id` equals either sentinel, step 9 is skipped.

## Promise worker flow

A promise worker runs a single actor function and sends the result back:

```
pgmq.read() on promise queue
  │
processFSMPromiseQueueMessage()
  │  — calls actorFn(event_payload)
  │  — on success: send_event_name = "xstate.done.actor.<name>"
  │  — on error:   send_event_name = "xstate.error.actor.<name>"
  │
archiveEventFromFsmPromiseTypeWorker()
  → archive_event_from_fsm_promise_type_worker_v2()
    — writes event log with result
    — sends result event back to parent FSM queue
    — archives the promise queue message
```

The parent FSM worker picks up the `xstate.done.actor.*` or
`xstate.error.actor.*` event in its next poll and evaluates the transitions that
match.
