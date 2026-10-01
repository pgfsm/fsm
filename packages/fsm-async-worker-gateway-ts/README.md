# @pgfsm/async-worker-gateway

The Activity Gateway for async-operation-type FSM operations across polyglot
(TypeScript/Python/Rust/Go) actors: a standalone gateway process that accepts
worker registrations over a Unix socket and/or over TCP (TLS, with a bearer
token or mutual TLS), polls Postgres for pending work matching those
registrations, dispatches it to the right worker, and archives the result.
Optionally exposes a client-facing gRPC/Connect `Invoke` API.

Previously published as `@pgfsm/async-worker` (up to 0.1.6, now deprecated). The
actor processes that connect to this gateway use
[`@pgfsm/async-worker-sdk`](https://www.npmjs.com/package/@pgfsm/async-worker-sdk)
(TypeScript).

## Install

This package ships two CLI bins, so a plain `npx @pgfsm/async-worker-gateway`
can't tell which one to run — pass `-p`/`--package` and name the bin after `--`:

```bash
npx -p @pgfsm/async-worker-gateway -- async-operation-worker-gateway --help
```

or install it as a dependency / global CLI, after which each bin is callable
directly:

```bash
npm install @pgfsm/async-worker-gateway
npm install -g @pgfsm/async-worker-gateway   # for global `async-operation-worker-gateway`/`-ctl` commands
```

No Deno install is required to use the CLIs this way.

## Usage

Two CLIs ship in this package. Run either with `--help` for its full flag
reference. Examples below assume a global install
(`async-operation-worker-gateway ...`); via plain `npx` prefix each with
`npx -p @pgfsm/async-worker-gateway --`.

### `async-operation-worker-gateway` — start the gateway process

**Input** — all flags optional:

- `-b`/`--bind <target>` — gRPC bind target for the client-facing API (default
  `unix:/tmp/pgfsm-activity-gateway.sock`)
- `-s`/`--sidecar-socket <path>` — Unix socket worker processes connect to and
  register actors on (default `/tmp/pgfsm-activity-gateway-workers.sock`)
- `-t`/`--invoke-timeout-ms <ms>` — per-invoke timeout for actors that don't
  declare their own `timeout_ms` (default `10000`)
- `--vt-margin-seconds <s>` — claimed messages stay invisible for the invoke
  timeout plus this (default `10`)
- `--max-delivery-attempts <n>` — deliveries before a retriable failure (no
  worker, worker disconnected, timeout) is archived as an actor error instead of
  being delivered again (default `5`). Delivery is at-least-once, so actors must
  be idempotent.
- `-d`/`--db-url <url>` — Postgres connection string (falls back to
  `DATABASE_URL` from `.env`); required unless both `--disable-poll-loop` and
  `--ensure-queue-on-register` are omitted/off
- `--poll-interval-ms <ms>` — poll-loop interval (default `30000`)
- `--sidecar-listen <target>` — also (or instead) accept workers on
  `unix:<path>` or `tcp://<host>:<port>`. With neither this nor
  `--sidecar-socket`, the default socket is served as before.
- `--tls-cert <file>` / `--tls-key <file>` — TLS for a `tcp://` listener
  (required unless `--insecure-plaintext`, which is for local testing only)
- `--tls-min-version <1.2|1.3>` — lowest accepted TLS version (default `1.3`)
- `--tls-client-ca <file>` — mutual TLS: require worker client certificates
  signed by this CA
- `--auth-token-file <file>` — bearer token TCP workers must send; re-read for
  every new session, so a mounted Secret can be rotated without a restart
- `--max-connection-age-ms <ms>` — drain and disconnect TCP workers after this
  long (default `600000`, ±10 %; `0` disables), so they spread across replicas
- `--keepalive-interval-ms <ms>` / `--keepalive-timeout-ms <ms>` — HTTP/2 PINGs
  on TCP worker connections (defaults `30000` / `10000`)
- `--disable-poll-loop` — run the gateway/sidecar only, no Postgres poll loop
- `--ensure-queue-on-register` — also ensure a PGMQ queue exists for every actor
  a worker registers (default off; best-effort — a name that exceeds PGMQ's
  48-character limit fails only this step, not the registration)

**Output/side effect** — starts a long-running process: a gRPC service
(client-facing) backed by a sidecar (worker-facing, Unix socket and/or TCP),
plus — unless disabled — its own Postgres poll loop that claims and dispatches
pending async-operation-type work to whichever actors are currently registered,
then archives each result. Runs until `SIGINT`/`SIGTERM` (a second signal
force-exits).

```bash
async-operation-worker-gateway
async-operation-worker-gateway --disable-poll-loop
async-operation-worker-gateway --db-url "$DATABASE_URL" --ensure-queue-on-register

# As its own Deployment: workers connect over TLS with a bearer token
async-operation-worker-gateway --sidecar-listen tcp://0.0.0.0:7443 \
  --tls-cert tls.crt --tls-key tls.key --auth-token-file token
```

Running the gateway as its own Deployment (SPEC-007) lets each language's
workers scale and release independently, and keeps Postgres connections at
gateway replicas × pool size however many workers run. See the CLI guide's "TCP
listener, TLS and authentication" section for the details.

### `async-operation-worker-gateway-ctl` — debug/test client

**Input** — first positional argument is the subcommand, `list` or `invoke`;
`--target <target>` (default `unix:/tmp/pgfsm-activity-gateway.sock`) selects
which running gateway to talk to.

- `list` — no further flags.
- `invoke` — requires `--parent-fsm-name`, `--parent-fsm-version`,
  `--async-operation-type`, `--async-operation-name`,
  `--async-operation-version`, `--async-operation-language`; optional
  `--input <json>` (default `null`), `--instance-id`/`--correlation-id` (default
  random UUIDs), `--timeout-ms` (default `5000`).

**Output** — writes nothing; `list` prints the actor keys currently registered
with the target gateway, `invoke` calls that actor and prints its result JSON.

```bash
async-operation-worker-gateway-ctl list

async-operation-worker-gateway-ctl invoke \
  --parent-fsm-name creditCheck --parent-fsm-version v01 \
  --async-operation-type internalAsyncOperation --async-operation-name checkBureau --async-operation-version v01 \
  --async-operation-language rust --input '{"ssn":"123"}'
```

## Prerequisites

- **A Postgres database** — `DATABASE_URL`, needed for the poll loop and/or
  `--ensure-queue-on-register` (omit both to run the gateway/sidecar only)
- **At least one worker-sdk process** connected to the sidecar socket, to
  register actors and actually serve invocations — generate one from an FSM's
  compiled actors (`npx @pgfsm/cli create`), or see
  `test-apps/debug-only/async-worker/<lang>/` in the
  [repo](https://github.com/pgfsm/fsm) for a worked example

## Programmatic usage

```typescript
import {
  ActivityGatewayClient, // invoke actors through the gateway's client-facing API
  SidecarGateway, // the sidecar itself — worker registration + dispatch
  startActivityGatewayServer, // sidecar + gRPC/Connect server + poll loop, all in one process
  startAsyncOpPollLoop, // the poll/claim/archive loop, standalone
} from "@pgfsm/async-worker-gateway";

import type {
  ActivityGatewayClientOptions,
  AsyncOpPollLoopOptions,
  GatewayServerOptions,
  InvokeActorRequest,
  InvokeActorResult,
} from "@pgfsm/async-worker-gateway";
```

## License

Apache-2.0
