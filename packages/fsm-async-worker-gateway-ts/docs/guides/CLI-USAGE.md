# fsm-async-worker-gateway-ts — CLI Usage Guide

## Core objective

`fsm-async-worker-gateway-ts` (`@pgfsm/async-worker-gateway`) is a **standalone
alternative to `fsm-async-worker-ts`** for async-operation-type async FSM
operations across polyglot (TypeScript/Python/Rust/Go) actors — not a passive
service another orchestrator's poll/claim/archive loop calls into.

Concretely, it:

1. **Accepts worker registrations** — TS/Python/Rust/Go worker processes connect
   to the "sidecar" and announce which actors they serve (`SidecarGateway`):
   over a Unix socket (single pod) and/or over TCP with TLS, a bearer token or
   mutual TLS (the gateway as its own Deployment, SPEC-007).
2. **Owns its own Postgres connection and poll loop** — every 30 seconds
   (default), claims pending work for its currently-registered actors, at most
   as many messages per actor as its workers have free slots
   (`claimPendingAsyncOperationEventsWithCapacity` — see "Poll loop behavior"
   and the "PGMQ message payload shape" section below), with zero dependency on
   any external orchestrator's poll loop.
3. **Dispatches and archives** — for each claimed item, invokes the right worker
   over its sidecar session (`sidecar.invoke()`) and archives the result
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
   `test-apps/debug-only/async-worker/<lang>/` (a `@pgfsm/cli`-generated
   project, #405).

---

## async-operation-worker-gateway — gateway + sidecar + poll loop

Starts the sidecar (accepts worker registrations over a Unix socket and/or a TCP
listener), the client-facing gRPC/Connect server, and — unless disabled — the
30-second async-op poll loop, all in one process sharing one `SidecarGateway`
instance.

### Invocation

```bash
# From repo root
deno run --allow-all packages/fsm-async-worker-gateway-ts/src/cli/async-operation-worker-gateway.ts [options]

# From this package's own directory
deno task gateway [options]
```

### Options

| Flag                           | Alias | Required                                                  | Default                                    | Description                                                                                                                                              |
| ------------------------------ | ----- | --------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--bind <target>`              | `-b`  | no                                                        | `unix:/tmp/pgfsm-activity-gateway.sock`    | gRPC bind target — `unix:<path>` or `host:port`                                                                                                          |
| `--sidecar-socket <path>`      | `-s`  | no                                                        | `/tmp/pgfsm-activity-gateway-workers.sock` | Unix socket path workers connect to and register on. The default applies only when `--sidecar-listen` isn't given either                                 |
| `--sidecar-listen <target>`    |       | no                                                        | —                                          | Also (or instead) listen for workers on `unix:<path>` or `tcp://<host>:<port>` (see "TCP listener" below)                                                |
| `--tls-cert <file>`            |       | for `tcp://`, unless `--insecure-plaintext`               | —                                          | PEM certificate chain the TCP listener presents                                                                                                          |
| `--tls-key <file>`             |       | with `--tls-cert`                                         | —                                          | PEM private key for `--tls-cert`                                                                                                                         |
| `--tls-min-version <v>`        |       | no                                                        | `1.3`                                      | Lowest TLS version the TCP listener accepts: `1.2` or `1.3`                                                                                              |
| `--tls-client-ca <file>`       |       | no                                                        | —                                          | Mutual TLS: require worker client certificates signed by this CA                                                                                         |
| `--insecure-plaintext`         |       | no                                                        | off                                        | Allow a `tcp://` listener without TLS. Local testing only; logs a warning                                                                                |
| `--auth-token-file <file>`     |       | no                                                        | —                                          | An accepted bearer token for TCP workers; repeatable (e.g. old and new during a rotation). Re-read for every new session                                 |
| `--auth-token-dir <dir>`       |       | no                                                        | —                                          | A directory of accepted tokens, one per file (e.g. a Kubernetes Secret with one key per language); hidden entries skipped. Re-read for every new session |
| `--max-connection-age-ms <ms>` |       | no                                                        | `600000`                                   | Drain and disconnect TCP workers after this long, ±10 % jitter; `0` disables                                                                             |
| `--keepalive-interval-ms <ms>` |       | no                                                        | `30000`                                    | HTTP/2 PING interval on TCP worker connections; `0` disables                                                                                             |
| `--keepalive-timeout-ms <ms>`  |       | no                                                        | `10000`                                    | Close a TCP connection whose PING goes unanswered this long                                                                                              |
| `--invoke-timeout-ms <ms>`     | `-t`  | no                                                        | `10000`                                    | Per-invoke timeout for the gRPC `Invoke` RPC and for poll-loop dispatches of actors that don't declare their own `timeout_ms`                            |
| `--vt-margin-seconds <s>`      |       | no                                                        | `10`                                       | Claimed messages stay invisible for the invoke timeout plus this (see below)                                                                             |
| `--max-delivery-attempts <n>`  |       | no                                                        | `5`                                        | Deliveries before a retriable failure is archived as an actor error (see below)                                                                          |
| `--db-url <url>`               | `-d`  | only if poll loop or `--ensure-queue-on-register` enabled | `DATABASE_URL` from `.env`                 | PostgreSQL connection string — one pool, shared by both features when both are enabled                                                                   |
| `--poll-interval-ms <ms>`      |       | no                                                        | `30000`                                    | Async-op poll loop interval                                                                                                                              |
| `--disable-poll-loop`          |       | no                                                        | off (poll loop runs by default)            | Run the gateway/sidecar only — no Postgres connection needed (unless `--ensure-queue-on-register`)                                                       |
| `--ensure-queue-on-register`   |       | no                                                        | off                                        | Ensure a PGMQ queue exists for every actor a worker registers (see below)                                                                                |
| `--version`                    | `-v`  | —                                                         | —                                          | Print `@pgfsm/async-worker-gateway`'s version and exit                                                                                                   |
| `--help`                       | `-h`  | —                                                         | —                                          | Print help and exit                                                                                                                                      |

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

# Gateway as its own Deployment: workers connect over TLS with a bearer token
deno task gateway \
  --sidecar-listen tcp://0.0.0.0:7443 \
  --tls-cert /etc/pgfsm/tls/tls.crt --tls-key /etc/pgfsm/tls/tls.key \
  --auth-token-file /etc/pgfsm/token/token

# One token per language: a Secret with keys python, go, ... mounted as a directory
deno task gateway \
  --sidecar-listen tcp://0.0.0.0:7443 \
  --tls-cert /etc/pgfsm/tls/tls.crt --tls-key /etc/pgfsm/tls/tls.key \
  --auth-token-dir /etc/pgfsm/tokens

# Same, with mutual TLS instead of (or as well as) the token
deno task gateway \
  --sidecar-listen tcp://0.0.0.0:7443 \
  --tls-cert /etc/pgfsm/tls/tls.crt --tls-key /etc/pgfsm/tls/tls.key \
  --tls-client-ca /etc/pgfsm/tls/workers-ca.crt

# Migration: keep the pod-local socket and add the TCP listener
deno task gateway \
  --sidecar-socket /tmp/pgfsm-activity-gateway-workers.sock \
  --sidecar-listen tcp://0.0.0.0:7443 \
  --tls-cert tls.crt --tls-key tls.key --auth-token-file token

# Local testing only: plaintext TCP (logs a warning)
deno task gateway --sidecar-listen tcp://127.0.0.1:7443 --insecure-plaintext
```

### Startup sequence

1. **Sidecar** — binds every worker listener: the Unix socket and/or the
   `--sidecar-listen` target (`SidecarGateway.start()`), logging each address.
   If `--ensure-queue-on-register` is set, every actor a worker registers also
   triggers a PGMQ queue-ensure call (see below) — fire-and-forget, doesn't
   block or fail registration itself.
2. **Poll loop** (unless `--disable-poll-loop`) — starts against the same
   `SidecarGateway` instance, so it always dispatches to whichever workers are
   currently registered.
3. **gRPC/Connect server** — binds `--bind` and starts serving `Invoke` /
   `ListRegisteredActors`.

### TCP listener, TLS and authentication

By default workers reach the sidecar over a Unix socket, so the gateway and
every language's workers share one pod. `--sidecar-listen tcp://<host>:<port>`
lets workers connect over the network instead, so the gateway runs as its own
Deployment behind a Service and each language scales and releases on its own
(SPEC-007). Workers always open the connection
(`--gateway-address
https://<service>:<port>` in each SDK); the gateway never
dials workers.

- **Both at once.** `--sidecar-socket` and `--sidecar-listen` can be combined,
  so a single-pod setup can move one language at a time. With neither flag, the
  default socket is served exactly as before.
- **TLS.** A `tcp://` listener needs `--tls-cert` and `--tls-key`. TLS 1.3 is
  the minimum by default (`--tls-min-version 1.2` relaxes it). Plaintext TCP is
  refused unless you pass `--insecure-plaintext`, which is for local testing
  only and logs a warning.
- **Bearer tokens.** With `--auth-token-file` (repeatable) and/or
  `--auth-token-dir`, a TCP worker must send `authorization: Bearer <token>`
  (`--gateway-token-file` in the SDKs) matching one of the accepted tokens. A
  missing or wrong token gets `UNAUTHENTICATED` before its `Register` is read.
  Every source is re-read for each new session, so tokens can be added and
  removed without restarting the gateway. Each token is compared in constant
  time, and the gateway logs which one (by file name, never the value) a worker
  authenticated with.
  - **Rotation with overlap:** add the new token (a new Secret key, or a second
    `--auth-token-file`), switch the workers' token files, then remove the old
    token. Workers that reconnect in between are accepted with either.
  - **One token per language or service:** mount a Secret with one key per
    language as `--auth-token-dir`, and give each language's worker Deployment
    only its own key, so a leaked token exposes one language, not all.
  - An empty or unreadable token source is skipped and logged. If none is left,
    every TCP session is refused (and the gateway warns at startup).
- **Mutual TLS.** With `--tls-client-ca`, a worker must present a client
  certificate signed by that CA (`--gateway-cert-file`/`--gateway-key-file` in
  the SDKs), or the TLS handshake fails before any gRPC call. It identifies
  workers without a shared secret, and works alone or together with the token.
- **Unix-socket sessions aren't checked**: only processes that share the pod can
  reach the socket.

If a TCP listener has neither a token nor a client CA, the gateway logs a
warning at startup: any client that can reach it can register as a worker.

### Max connection age and keepalive

Both apply to TCP worker connections only; Unix-socket workers behave as before.

- **Max connection age** (`--max-connection-age-ms`, default 10 min ±10 %
  jitter). A Kubernetes Service balances per connection, so a worker stays on
  the gateway replica it first reached. After its max age the worker is
  **drained**: it gets no new invokes and counts for no capacity, its in-flight
  invokes are allowed to finish (up to 30 s), and then its stream ends and its
  connection is closed with GOAWAY. The worker reconnects as normal, possibly to
  another replica, which spreads workers across replicas added by scale-out.
- **Keepalive** (`--keepalive-interval-ms`, default 30 s;
  `--keepalive-timeout-ms`, default 10 s). The gateway PINGs each TCP
  connection, and one whose PING goes unanswered is closed. A half-open
  connection (node loss, a NetworkPolicy blackhole) is therefore noticed within
  about 40 s: the worker is unregistered and its in-flight invokes fail as
  retriable, so their messages are delivered again (#396). The SDKs PING the
  gateway the same way, so their side notices and reconnects too.

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

1. Reads `sidecar.listClaimableActors()`: every registered actor with its **free
   slots**, the sum over its workers of `max_concurrency` (declared per actor at
   `Register`; 0 means 1) minus that worker's in-flight invokes of it. If
   nothing is registered, skips this tick entirely (no DB call); actors with no
   free slot are left out of the claim (SPEC-007).
2. Calls `claimPendingAsyncOperationEventsWithCapacity(deps, claims)`
   (`fsm_core.claim_pending_async_operation_events_with_capacity_v2` under the
   hood). For each actor with free slots, it computes the queue name (same rule
   as `--ensure-queue-on-register` above, via the shared
   `fsm_core.compute_async_operation_queue_name_v2`), skips actors with no
   existing queue, and reads **up to the free slots** from each queue that
   exists, with a visibility timeout of
   `ceil(invoke timeout / 1000) + --vt-margin-seconds`. The invoke timeout is
   the actor's own `timeout_ms`, else `--invoke-timeout-ms`, so a claimed
   message can't become visible (and be claimed by another gateway replica)
   while its invoke may still be running. Each row also carries `readCount`
   (PGMQ's `read_ct`).
3. For each claimed row: dispatches via `sidecar.invoke()` (to the worker with
   the most free slots for that actor), then archives the result via
   `archiveEventFromFsmAsyncOperationTypeWorker()`. Fire-and-forget, so one
   slow/failed dispatch never blocks another actor's dispatch or the next poll
   tick.

#### Retriable failures are delivered again (#396)

A failed invoke is only reported to the FSM (archived as
`xstate.error.actor.<event>`) when the failure is about the actor: it threw, or
its worker answered with a non-retriable error. Failures that say nothing about
the actor are **retriable**:

- `ACTOR_NOT_FOUND` / `WORKER_UNAVAILABLE`: no worker for the actor right now
  (e.g. it's reconnecting between claim and dispatch);
- `WORKER_DISCONNECTED`: the worker went away mid-invoke (restart, rollout,
  dropped connection);
- `TIMEOUT`: no result within the invoke timeout;
- any error a worker sends with `retriable: true`.

For those, the gateway doesn't archive anything. The message stays on its queue,
becomes visible again when its visibility timeout ends, and a later tick
delivers it again. Only once it has been delivered `--max-delivery-attempts`
times (default 5, from `readCount`) is it archived as a failed actor call.

**Delivery is at-least-once, so actors must be idempotent.** A gateway crash
mid-invoke, or a result the gateway never received, means the actor may run
again for the same message.

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

| Signal                             | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ctrl+C once** (SIGINT / SIGTERM) | Stops accepting new gRPC connections and gives open ones up to 5 s to finish. Then it closes the sidecar: in-flight invokes fail as `WORKER_DISCONNECTED` (retriable, so their messages are delivered again), every worker's session ends (so it reconnects to the next gateway), and any worker connection still open after another 5 s is dropped, on every listener. Finally it removes the Unix sockets and closes the DB pool (if the poll loop was running). Shutdown no longer waits indefinitely on connected workers (#397). |
| **Ctrl+C twice**                   | Force-exit (`Deno.exit(0)`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

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
deno run --allow-all packages/fsm-async-worker-gateway-ts/src/cli/async-operation-worker-gateway-ctl.ts <list|invoke> [options]

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
| `--version`                         | —            | —                                       | Print `@pgfsm/async-worker-gateway`'s version and exit        |
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

Run from `packages/fsm-async-worker-gateway-ts/`, each task takes the CLI's own
flags after the task name, e.g. `deno task gateway --disable-poll-loop`.
Equivalent direct invocations from the repo root:

```bash
deno run --allow-all packages/fsm-async-worker-gateway-ts/src/cli/async-operation-worker-gateway.ts [options]
deno run --allow-all packages/fsm-async-worker-gateway-ts/src/cli/async-operation-worker-gateway-ctl.ts <list|invoke> [options]
```

---

## Exit codes

| Code | Meaning                                                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Command completed (or long-running gateway process exited) successfully                                                           |
| `1`  | Invalid/missing required arguments, poll loop enabled with no DB URL, failed to bind a socket, or a `gateway-ctl` RPC call failed |
