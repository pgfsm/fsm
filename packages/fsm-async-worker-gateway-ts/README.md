# @pgfsm/async-worker-gateway

The Activity Gateway for async-operation-type FSM operations across polyglot
(TypeScript/Python/Rust/Go) actors: a standalone gateway process that accepts
worker registrations over a Unix socket, polls Postgres for pending work
matching those registrations, dispatches it to the right worker, and archives
the result. Optionally exposes a client-facing gRPC/Connect `Invoke` API.

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
- `-t`/`--invoke-timeout-ms <ms>` — default per-invoke timeout (default `10000`)
- `-d`/`--db-url <url>` — Postgres connection string (falls back to
  `DATABASE_URL` from `.env`); required unless both `--disable-poll-loop` and
  `--ensure-queue-on-register` are omitted/off
- `--poll-interval-ms <ms>` — poll-loop interval (default `30000`)
- `--disable-poll-loop` — run the gateway/sidecar only, no Postgres poll loop
- `--ensure-queue-on-register` — also ensure a PGMQ queue exists for every actor
  a worker registers (default off; best-effort — a name that exceeds PGMQ's
  48-character limit fails only this step, not the registration)

**Output/side effect** — starts a long-running process: a gRPC service
(client-facing) backed by a Unix-socket sidecar (worker-facing), plus — unless
disabled — its own Postgres poll loop that claims and dispatches pending
async-operation-type work to whichever actors are currently registered, then
archives each result. Runs until `SIGINT`/`SIGTERM` (a second signal
force-exits).

```bash
async-operation-worker-gateway
async-operation-worker-gateway --disable-poll-loop
async-operation-worker-gateway --db-url "$DATABASE_URL" --ensure-queue-on-register
```

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
  compiled actors (see `@pgfsm/compiler`'s `generate-async-logic`), or see
  `apps/async-worker/<lang>/` (a sibling of `apps/fsm-core-example/` — see #316)
  in the [repo](https://github.com/pgfsm/fsm) for a worked example

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
