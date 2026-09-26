# fsm-core-async-op-worker — CLI Usage Guide

## Core objective

`fsm-core-async-op-worker` (`@pgfsm/async-worker`) is a **standalone alternative
to `fsm-async-worker-ts`** for async-operation-type async FSM operations across
polyglot (TypeScript/Python/Rust/Go) actors — not a passive service another
orchestrator's poll/claim/archive loop calls into.

Concretely, it:

1. **Accepts worker registrations** — TS/Python/Rust/Go worker processes connect
   over a Unix socket (the "sidecar") and announce which actors they serve
   (`SidecarGateway`).
2. **Owns its own Postgres connection and poll loop** — every 30 seconds
   (default), asks Postgres which pending work matches its currently-registered
   workers (`claimPendingAsyncOperationEventsForWorkers` — see the "PGMQ message
   payload shape" section below), with zero dependency on any external
   orchestrator's poll loop.
3. **Dispatches and archives** — for each claimed item, invokes the right worker
   over the sidecar socket (`sidecar.invoke()`) and archives the result
   (`archiveEventFromFsmAsyncOperationTypeWorker`), non-blocking, per actor.
4. **Optionally exposes a client-facing gRPC/Connect API** (`Invoke`,
   `ListRegisteredActors`) — the _original_ reason this package existed (a
   gateway another orchestrator calls into), now secondary to (2)/(3) since this
   process pulls its own work rather than waiting to be called.

See `../../GOAL.md` for the full goal-vs-current-implementation comparison this
package is being built against.

This package provides two CLIs:

| CLI                                    | Entry point                                     | Role                                                                                      |
| -------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **async-operation-worker-gateway**     | `src/cli/async-operation-worker-gateway.ts`     | Long-running process: sidecar (worker registration) + gRPC/Connect server + 30s poll loop |
| **async-operation-worker-gateway-ctl** | `src/cli/async-operation-worker-gateway-ctl.ts` | One-shot debug/test client — `list` or `invoke` against a running gateway, then exits     |

---

## Prerequisites

1. **Deno** — see `.prototools` at the repo root for the pinned version.
2. **Database connection** (only needed for the poll loop — see
   `--disable-poll-loop` below) — one of:
   - `.env` file in the directory you run the CLI from, containing
     `DATABASE_URL=postgresql://...`
   - `--db-url` / `-d` flag passed directly (takes precedence over `.env`)
3. **At least one worker-sdk process** to register actors and actually serve
   invocations — see `packages/fsm-proto-codegen/`'s generated stubs, or
   `apps/async-worker/<lang>/` (a sibling of `apps/fsm-core-example/` — see
   #316) if `fsm-compiler-ts`'s `generate-async-logic` has been run.

---

## async-operation-worker-gateway — gateway + sidecar + poll loop

Starts the sidecar (accepts worker registrations over a Unix socket), the
client-facing gRPC/Connect server, and — unless disabled — the 30-second
async-op poll loop, all in one process sharing one `SidecarGateway` instance.

### Invocation

```bash
# From repo root
deno run --allow-all packages/fsm-core-async-op-worker/src/cli/async-operation-worker-gateway.ts [options]

# From this package's own directory
deno task gateway [options]
```

### Options

| Flag                         | Alias | Required                                                  | Default                                    | Description                                                                                        |
| ---------------------------- | ----- | --------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `--bind <target>`            | `-b`  | no                                                        | `unix:/tmp/pgfsm-activity-gateway.sock`    | gRPC bind target — `unix:<path>` or `host:port`                                                    |
| `--sidecar-socket <path>`    | `-s`  | no                                                        | `/tmp/pgfsm-activity-gateway-workers.sock` | Unix socket path workers connect to and register on                                                |
| `--invoke-timeout-ms <ms>`   | `-t`  | no                                                        | `10000`                                    | Default per-invoke timeout, used by both the gRPC `Invoke` RPC and the poll loop's dispatches      |
| `--db-url <url>`             | `-d`  | only if poll loop or `--ensure-queue-on-register` enabled | `DATABASE_URL` from `.env`                 | PostgreSQL connection string — one pool, shared by both features when both are enabled             |
| `--poll-interval-ms <ms>`    |       | no                                                        | `30000`                                    | Async-op poll loop interval                                                                        |
| `--disable-poll-loop`        |       | no                                                        | off (poll loop runs by default)            | Run the gateway/sidecar only — no Postgres connection needed (unless `--ensure-queue-on-register`) |
| `--ensure-queue-on-register` |       | no                                                        | off                                        | Ensure a PGMQ queue exists for every actor a worker registers (see below)                          |
| `--version`                  | `-v`  | —                                                         | —                                          | Print `@pgfsm/async-worker`'s version and exit                                                     |
| `--help`                     | `-h`  | —                                                         | —                                          | Print help and exit                                                                                |

> **Poll loop is on by default; `--ensure-queue-on-register` is opt-in.** If
> either needs a DB connection and neither `--db-url` nor `DATABASE_URL` is set,
> the process logs an error and exits `1` before starting anything.

### Examples

```bash
# Full standalone mode (default): gateway + sidecar + poll loop,
# DATABASE_URL from .env
deno task gateway

# Explicit db-url, custom poll interval
deno task gateway \
  --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  --poll-interval-ms 15000

# Gateway/sidecar only, no DB connection at all
deno task gateway --disable-poll-loop

# Poll loop off, but still ensure queues exist on registration
deno task gateway --disable-poll-loop --ensure-queue-on-register

# Custom bind/sidecar sockets (e.g. running two instances side by side)
deno task gateway \
  --bind unix:/tmp/my-gateway.sock \
  --sidecar-socket /tmp/my-gateway-workers.sock \
  --disable-poll-loop
```

### Startup sequence

1. **Sidecar** — binds the Unix socket workers register on
   (`SidecarGateway.start()`). If `--ensure-queue-on-register` is set, every
   actor a worker registers also triggers a PGMQ queue-ensure call (see below) —
   fire-and-forget, doesn't block or fail registration itself.
2. **Poll loop** (unless `--disable-poll-loop`) — starts against the same
   `SidecarGateway` instance, so it always dispatches to whichever workers are
   currently registered.
3. **gRPC/Connect server** — binds `--bind` and starts serving `Invoke` /
   `ListRegisteredActors`.

### `--ensure-queue-on-register` behavior

For every actor a worker registers, calls `ensureAsyncOperationQueueForWorker`
(`fsm_core.ensure_async_operation_queue_for_worker_v2` under the hood), which
ensures a PGMQ queue exists — idempotent, safe on every re-registration, not
just the first. `asyncOperationType` is always shortened to its first character;
when `asyncOperationType` is exactly `"internalAsyncOperation"`,
`asyncOperationVersion` is dropped entirely and `asyncOperationLanguage` is also
shortened to its first character:

```
asyncOperationType "internalAsyncOperation":  <parentFsmName>_<parentFsmVersion>_<asyncOperationType[0]>_<asyncOperationName>_<asyncOperationLanguage[0]>
otherwise:                         <parentFsmName>_<parentFsmVersion>_<asyncOperationType[0]>_<asyncOperationName>_<asyncOperationVersion>_<asyncOperationLanguage>
```

Unlike the older `sharedPromise_<asyncOperationName>_<asyncOperationVersion>`
convention, this one is still unique per actor identity _including language_ in
the `"internalAsyncOperation"` case — two workers of different languages never
share a queue, since no two of `typescript`/`python`/`rust`/`go` share a first
letter (`t`/`p`/`r`/`g`) today.

> **PGMQ enforces a hard 48-character queue name limit.** The
> `"internalAsyncOperation"` shortening is enough for typical identities —
> verified: `creditCheck_v01_i_checkReportsTable_t` is 37 characters, well under
> the limit, for a real long-name example that _didn't_ fit before this change
> (`creditCheck_v01_i_checkReportsTable_v01_typescript` was 50 characters). The
> non-`"internalAsyncOperation"` path (`sharedAsyncOperation` etc.) still
> carries the full `asyncOperationVersion` + `asyncOperationLanguage` and
> remains more exposed to the limit — long `parentFsmName`/`asyncOperationName`
> values can still exceed it either way. The queue-ensure call throws in that
> case (logged as an error), but registration itself still succeeds; the actor
> just won't have a queue.

### Poll loop behavior (when enabled)

Every `--poll-interval-ms` (default 30s):

1. Reads `sidecar.listRegisteredActorIdentities()` — if nothing is registered,
   skips this tick entirely (no DB call).
2. Calls `claimPendingAsyncOperationEventsForWorkers(deps, workers)`
   (`fsm_core.claim_pending_async_operation_events_for_workers_v2` under the
   hood) — for each registered worker identity, computes its queue name (same
   rule as `--ensure-queue-on-register` above, via the shared
   `fsm_core.compute_async_operation_queue_name_v2`), skips identities with no
   existing queue, and reads up to one message (`vt=30s`) from each queue that
   exists.
3. For each claimed row: dispatches via `sidecar.invoke()`, then archives the
   result via `archiveEventFromFsmAsyncOperationTypeWorker()` — fire-and-forget,
   so one slow/failed dispatch never blocks another actor's dispatch or the next
   poll tick.

#### PGMQ message payload shape

The poll loop reads whatever `pgmq.send()` put in an internalAsyncOperation
actor's queue — same shape
`fsm_core.send_event_to_async_operation_queue_with_event_logs_v2` already
builds:

```json
{
  "eventData": {
    "eventType": "checkBureau",
    "eventPayload": { "ssn": "123-45-6789", "applicantName": "Jane Doe" },
    "actionType": "invoke"
  },
  "queueId": "creditCheck_v01_i_checkBureau_t",
  "queueFnName": "checkBureau",
  "queueType": "internalAsyncOperation",
  "queueVersion": "v01",
  "sendToParentQueueId": "d88bbbf6-1083-4ec8-8e53-a8add4f69e72",
  "sendToParentQueueType": "fsm",
  "sendToParentQueueIdEventName": "xstate.done.actor.checkBureau",
  "queueMsgId": 1,
  "queueMsgDelay": 0
}
```

Field mapping — only these fields feed the claimed row (identity fields
`parentFsmName`/`parentFsmVersion`/`asyncOperationType`/`asyncOperationName`/`asyncOperationVersion`/
`asyncOperationLanguage` come from the _worker_ being iterated, not the
message):

| Message field                  | Claimed row field                              | Notes                                                                                       |
| ------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `eventData.eventPayload`       | `input`                                        | the actor's invoke input                                                                    |
| `eventData.actionType`         | `eventActionType`                              |                                                                                             |
| `sendToParentQueueId`          | `instanceId` and `sendToParentQueueId`         | the parent FSM instance UUID                                                                |
| `sendToParentQueueIdEventName` | `eventName` and `sendToParentQueueIdEventName` | raw value, not outcome-prefixed — see below                                                 |
| `queueMsgDelay`                | `eventDelay`                                   | defaults to `0` if absent                                                                   |
| (n/a)                          | `msgId`                                        | from the PGMQ message envelope itself (`msg_id`), not the payload                           |
| (n/a)                          | `correlationId`                                | the message's own `msg_id`, stringified — the stored payload has no separate correlation id |

`queueId`/`queueFnName`/`queueType`/`queueVersion`/`sendToParentQueueType` are
not read by the claim function.

> **Not computed:** an outcome-dependent `"xstate.done.actor."` /
> `"xstate.error.actor."` prefix on `eventName`. The claim function runs before
> `sidecar.invoke()`, so it can't know the outcome yet — `eventName` in the
> claimed row is always the raw `sendToParentQueueIdEventName` from the message.
> Whether/how to outcome-prefix it before archiving is a `dispatchAndArchive()`
> (TS-side) concern, not yet implemented.

To enqueue a test message directly (bypasses
`send_event_to_async_operation_queue_with_event_logs_v2`'s FK requirement on a
real `fsm_instance` row — useful for testing the poll loop without standing up a
full FSM instance), once a queue exists (e.g. via `--ensure-queue-on-register`
or a direct call to `ensure_async_operation_queue_for_worker_v2`):

```sql
SELECT pgmq.send('creditCheck_v01_i_checkBureau_t', jsonb_build_object(
    'eventData', jsonb_build_object(
        'eventType', 'checkBureau',
        'eventPayload', jsonb_build_object('ssn', '123-45-6789', 'applicantName', 'Jane Doe'),
        'actionType', 'invoke'
    ),
    'sendToParentQueueId', 'd88bbbf6-1083-4ec8-8e53-a8add4f69e72',
    'sendToParentQueueIdEventName', 'xstate.done.actor.checkBureau'
), 0);
```

#### Sample: no real parent (API sentinel)

An internalAsyncOperation actor invoked with no real FSM instance waiting on the
result (e.g. triggered directly via the API) uses
`fsm_core.api_system_queue_uuid()` (`00000000-0000-0000-0000-000000000001`) as
`sendToParentQueueId` instead of a real `fsm_instance` id:

```json
{
  "eventData": {
    "eventType": "checkBureau",
    "eventPayload": { "ssn": "123-45-6789", "applicantName": "Jane Doe" },
    "actionType": "invoke"
  },
  "queueId": "creditCheck_v01_i_checkBureau_t",
  "queueFnName": "checkBureau",
  "queueType": "internalAsyncOperation",
  "queueVersion": "v01",
  "sendToParentQueueId": "00000000-0000-0000-0000-000000000001",
  "sendToParentQueueType": "fsm",
  "sendToParentQueueIdEventName": "xstate.done.actor.checkBureau",
  "queueMsgId": 1,
  "queueMsgDelay": 0
}
```

`archive_event_from_fsm_async_operation_type_worker_v2` recognizes `NULL` and
both sentinel uuids — `fsm_core.pg_system_queue_uuid()` (`...0000`) and
`fsm_core.api_system_queue_uuid()` (`...0001`) — as "no real parent to notify"
and skips the parent-notify send, returning
`send_to_parent_result:
{"skipped": true, "reason": "no real parent to notify"}`
instead of raising. Any other uuid is treated as a real parent FSM instance id
and the send is attempted as normal.

To enqueue it directly for testing:

```sql
SELECT pgmq.send('creditCheck_v01_i_checkBureau_t', jsonb_build_object(
    'eventData', jsonb_build_object(
        'eventType', 'checkBureau',
        'eventPayload', jsonb_build_object('ssn', '123-45-6789', 'applicantName', 'Jane Doe'),
        'actionType', 'invoke'
    ),
    'sendToParentQueueId', fsm_core.api_system_queue_uuid()::text,
    'sendToParentQueueIdEventName', 'xstate.done.actor.checkBureau'
), 0);
```

### Graceful shutdown

| Signal                             | Behaviour                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Ctrl+C once** (SIGINT / SIGTERM) | Stops accepting new gRPC connections, closes the sidecar and its Unix socket, closes the DB pool (if the poll loop was running) |
| **Ctrl+C twice**                   | Force-exit (`Deno.exit(0)`)                                                                                                     |

### Environment variables

| Variable       | Description                                                                          |
| -------------- | ------------------------------------------------------------------------------------ |
| `DATABASE_URL` | Fallback DB connection string for the poll loop (used when `--db-url` is not passed) |

---

## async-operation-worker-gateway-ctl — one-shot debug/test client

A thin debug/test client for the gateway's gRPC/Connect API — connects, calls
one RPC, prints the result, and exits. Does **not** touch the sidecar socket or
Postgres directly; it only talks to a running `async-operation-worker-gateway`
process over its `--bind` target.

### Invocation

```bash
deno run --allow-all packages/fsm-core-async-op-worker/src/cli/async-operation-worker-gateway-ctl.ts <list|invoke> [options]

# From this package's own directory
deno task gateway-ctl <list|invoke> [options]
```

### Commands

| Command  | Description                                                                 |
| -------- | --------------------------------------------------------------------------- |
| `list`   | Calls `ListRegisteredActors` and prints the actor keys currently registered |
| `invoke` | Calls `Invoke` for the given actor identity and prints the result           |

### Options

| Flag                                | Required for | Default                                 | Description                                                   |
| ----------------------------------- | ------------ | --------------------------------------- | ------------------------------------------------------------- |
| `--target <target>`                 | no           | `unix:/tmp/pgfsm-activity-gateway.sock` | gRPC target to connect to — must match the gateway's `--bind` |
| `--parent-fsm-name <name>`          | `invoke`     | —                                       | Parent FSM name                                               |
| `--parent-fsm-version <ver>`        | `invoke`     | —                                       | Parent FSM version                                            |
| `--async-operation-type <type>`     | `invoke`     | —                                       | e.g. `internalAsyncOperation`                                 |
| `--async-operation-name <name>`     | `invoke`     | —                                       | Actor name                                                    |
| `--async-operation-version <ver>`   | `invoke`     | —                                       | Actor version                                                 |
| `--async-operation-language <lang>` | `invoke`     | —                                       | `typescript` \| `python` \| `rust` \| `go`                    |
| `--input <json>`                    | no           | `null`                                  | JSON-encoded input payload                                    |
| `--instance-id <id>`                | no           | random UUID                             | Correlates the invocation to an FSM instance                  |
| `--correlation-id <id>`             | no           | random UUID                             | Free-form correlation id                                      |
| `--timeout-ms <ms>`                 | no           | `5000`                                  | Client-side timeout for this one call                         |
| `--version`                         | —            | —                                       | Print `@pgfsm/async-worker`'s version and exit                |
| `--help`                            | —            | —                                       | Print help and exit                                           |

Identity flags match `sidecar/gateway.ts`'s `actorKey()` shape — the exact six
fields `list`'s output concatenates with `@`.

### Examples

```bash
# List everything currently registered
deno task gateway-ctl list

# Invoke a specific actor
deno task gateway-ctl invoke \
  --parent-fsm-name creditCheck --parent-fsm-version v01 \
  --async-operation-type internalAsyncOperation --async-operation-name checkBureau --async-operation-version v01 \
  --async-operation-language typescript \
  --input '{"ssn":"123"}'

# Against a non-default gateway target
deno task gateway-ctl list --target unix:/tmp/my-gateway.sock
```

For `invoke` to actually return a result (not an error), a worker-sdk process
for that exact actor identity must currently be registered with the gateway —
check with `list` first if unsure. Each command runs once and the process exits
(`0` on success, `1` on error).

---

## `deno.json` tasks

```json
{
  "tasks": {
    "gateway": "deno run --allow-all src/cli/async-operation-worker-gateway.ts",
    "gateway-ctl": "deno run --allow-all src/cli/async-operation-worker-gateway-ctl.ts",
    "check": "deno check src/index.ts"
  }
}
```

Run from `packages/fsm-core-async-op-worker/`, each task takes the CLI's own
flags after the task name, e.g. `deno task gateway --disable-poll-loop`.
Equivalent direct invocations from the repo root:

```bash
deno run --allow-all packages/fsm-core-async-op-worker/src/cli/async-operation-worker-gateway.ts [options]
deno run --allow-all packages/fsm-core-async-op-worker/src/cli/async-operation-worker-gateway-ctl.ts <list|invoke> [options]
```

---

## Exit codes

| Code | Meaning                                                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Command completed (or long-running gateway process exited) successfully                                                           |
| `1`  | Invalid/missing required arguments, poll loop enabled with no DB URL, failed to bind a socket, or a `gateway-ctl` RPC call failed |
