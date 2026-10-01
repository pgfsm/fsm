# @pgfsm/async-worker-sdk

TypeScript worker SDK for the pgfsm Activity Gateway. A worker process built on
it connects to the gateway's sidecar (a Unix socket in the same pod, or TCP with
TLS, a bearer token and/or mutual TLS when the gateway runs as its own
Deployment), registers a set of actors, and serves the invocations the gateway
routes to them over the `pgfsm.sidecargateway.v1.SidecarGatewayService` gRPC
stream (stubs from
[`@pgfsm/proto-codegen`](https://www.npmjs.com/package/@pgfsm/proto-codegen)).

It never opens a database connection — that stays in the gateway
(`@pgfsm/async-worker-gateway`).

## Usage

You normally don't write against this package directly. `@pgfsm/compiler`'s
`generate-async-logic` writes a small `run-async-worker.ts` plus a `deno.json`
that pins this package:

```ts
// async-worker/typescript/run-async-worker.ts (generated)
import { CATEGORY, configureLogging, isTerminal } from "@pgfsm/logging";
import { runActorWorkerCli } from "@pgfsm/async-worker-sdk";
import { ACTOR_REGISTRATIONS } from "./typescript-actors-registry.generated.ts";

await configureLogging({
  levels: { [CATEGORY.worker]: isTerminal ? "debug" : "info" },
});

Deno.exit(
  await runActorWorkerCli({
    registrations: ACTOR_REGISTRATIONS,
    args: Deno.args,
  }),
);
```

Run it from that directory:

```bash
deno task list    # print the actors in the registry, no gateway needed
deno task start   # connect to the gateway and serve invocations
# or, with options:
deno run --allow-all run-async-worker.ts start \
  --gateway-socket /tmp/pgfsm-activity-gateway-workers.sock
# the gateway as its own Deployment: TLS + bearer token, 10 invokes at once
deno run --allow-all run-async-worker.ts start \
  --gateway-address https://activity-gateway:7443 \
  --gateway-ca-file ca.crt --gateway-token-file token --max-concurrency 10
```

### CLI options (`runActorWorkerCli`)

| Flag                                | Default                                    | Meaning                                                                                                                                   |
| ----------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `-g, --gateway-socket <path>`       | `/tmp/pgfsm-activity-gateway-workers.sock` | Sidecar socket to connect to                                                                                                              |
| `-a, --gateway-address <addr>`      | —                                          | `unix:<path>`, `https://host:port`, or `http://host:port` (the gateway's `--insecure-plaintext` test mode); instead of `--gateway-socket` |
| `--gateway-ca-file <file>`          | system roots                               | PEM CA bundle trusting the gateway's TLS certificate                                                                                      |
| `--gateway-token-file <file>`       | —                                          | Bearer token sent as `authorization: Bearer`; re-read on every reconnect                                                                  |
| `--gateway-cert-file <file>`        | —                                          | Client certificate for mutual TLS (with `--gateway-key-file`)                                                                             |
| `--gateway-key-file <file>`         | —                                          | Its private key                                                                                                                           |
| `-c, --max-concurrency <n>`         | `1`                                        | Invokes of each actor run at once, for actors without their own `maxConcurrency` (see "Concurrency")                                      |
| `--keepalive-interval-ms <ms>`      | `30000`                                    | HTTP/2 PING interval over TCP; `0` disables                                                                                               |
| `--keepalive-timeout-ms <ms>`       | `10000`                                    | Reconnect when a PING goes unanswered this long                                                                                           |
| `--shutdown-grace-ms <ms>`          | `25000`                                    | On SIGINT/SIGTERM, how long in-flight invokes get to finish                                                                               |
| `-i, --worker-id <id>`              | `typescript-<random>`                      | Stable worker identity                                                                                                                    |
| `--heartbeat-ms <ms>`               | `5000`                                     | Heartbeat interval                                                                                                                        |
| `--reconnect-initial-delay-ms <ms>` | `250`                                      | First reconnect backoff step                                                                                                              |
| `--reconnect-max-delay-ms <ms>`     | `30000`                                    | Reconnect backoff cap                                                                                                                     |
| `--reconnect-max-attempts <n>`      | `0` (retry forever)                        | Exit after `n` consecutive failed attempts                                                                                                |
| `-h, --help`                        |                                            | Show help                                                                                                                                 |

`runActorWorkerCli` resolves to an exit code (0 or 1) rather than exiting.
Invalid flags (both `--gateway-socket` and `--gateway-address`, an unknown
address scheme, a certificate without its key, a missing credentials file, a
non-integer number) exit 1 before connecting.

`start` doesn't need the gateway to be up first: it retries the connection with
exponential backoff (full jitter, 250 ms doubling up to 30 s), and if a session
drops (e.g. the gateway restarts) it reconnects and re-registers on its own. A
session only resets the backoff once it has stayed up for 10 s, so a gateway
that accepts and immediately drops still gets backed off from. `start` ends with
exit code 1 only on what reconnecting can't fix: an explicit registration
rejection; a gRPC `UNAUTHENTICATED`, `PERMISSION_DENIED`, `UNIMPLEMENTED` or
`INVALID_ARGUMENT` (a misconfiguration, so it fails fast instead of retrying);
or `--reconnect-max-attempts` consecutive failed attempts. An invoke result that
can't be sent because its session ended is logged and dropped; the gateway has
already failed that invoke.

### Connecting over TCP (SPEC-007)

When the gateway runs as its own Deployment, point workers at its Service with
`--gateway-address https://<service>:<port>`:

- **TLS.** `--gateway-ca-file` trusts the gateway's certificate. The gateway
  requires TLS 1.3 by default; this SDK supports it.
- **Bearer token.** `--gateway-token-file` sends the token the gateway checks
  (`--auth-token-file` there). It's re-read on every reconnect, so a rotated
  Secret is picked up without restarting the worker. A wrong token is
  `UNAUTHENTICATED`, which ends `start` with exit code 1.
- **Mutual TLS.** `--gateway-cert-file`/`--gateway-key-file` present a client
  certificate when the gateway requires one (`--tls-client-ca` there).
  Certificate files are also re-read on every reconnect.
- **Keepalive.** Over TCP the worker PINGs the gateway, so a half-open
  connection is noticed and the worker reconnects.
- **Rebalancing.** Every session uses a new connection. When the gateway drains
  the worker after its max connection age, the worker reconnects through the
  Service and may land on another gateway replica.

`http://host:port` is only for a gateway started with `--insecure-plaintext`
(local testing).

### Concurrency

By default each actor handles **one invoke at a time**. To run more, set:

- `--max-concurrency <n>` (or `maxConcurrency` in `ActorWorkerOptions`): the
  worker-wide default for every actor;
- `maxConcurrency` on an actor's registration: that actor's own limit, which
  wins over the worker-wide one.

The effective limit per actor is **its own `maxConcurrency`, else the worker's,
else 1**. It's sent to the gateway at registration, so the gateway claims and
routes no more than that, and the worker also enforces it locally: extra invokes
of an actor wait for a slot.

**Above 1, handlers must be safe to run concurrently.** Invokes of the same
actor interleave at every `await`, so state shared across calls (module-level
variables, caches, counters, a single non-thread-safe client) can change under a
running invoke. Keep per-invoke state local, and share only clients that are
safe for concurrent use. A CPU-bound synchronous handler blocks the event loop
and gains nothing from concurrency; scale it out with more worker replicas
instead.

Separately from concurrency, **handlers must be idempotent**: delivery is
at-least-once, so an actor may run again for the same message (after a worker or
gateway restart, a dropped connection, or a timeout).

### Stopping

`stop()` (and SIGINT/SIGTERM under `runActorWorkerCli`) drains: invokes that
arrive while stopping are refused with a retriable `WORKER_DRAINING` error, so
the gateway delivers them again to another worker, and in-flight invokes are
allowed to finish for up to `shutdownGraceMs` (default 25 s; keep it below your
pod's termination grace period). Then the worker unregisters and disconnects.
`stop()` resolves once that's done.

### Using `ActorWorker` directly

```ts
import { type ActorRegistration, ActorWorker } from "@pgfsm/async-worker-sdk";

const registrations: ActorRegistration[] = [{
  parentFsmName: "creditCheck",
  parentFsmVersion: "v01",
  asyncOperationType: "internalAsyncOperation",
  asyncOperationName: "checkBureau",
  asyncOperationVersion: "v01",
  asyncOperationLanguage: "typescript",
  handler: (input) => ({ ok: true, input }),
}];

const worker = new ActorWorker(
  {
    workerId: "worker-1",
    language: "typescript",
    gatewaySocketPath: "/tmp/pgfsm-activity-gateway-workers.sock",
  },
  registrations,
);
// Reconnects and re-registers until worker.stop(); rejects only on a
// registration rejection or `reconnectMaxAttempts` failed attempts.
await worker.run();
```

Over TCP, pass `gatewayAddress` instead of `gatewaySocketPath`, plus `caFile`,
`tokenFile`, `certFile`/`keyFile` as needed. Give a registration
`maxConcurrency` to let that actor run several invokes at once.

A handler that throws is reported to the gateway as an `INTERNAL` invoke error;
an invoke for an actor this worker didn't register is reported as `NOT_FOUND`.

## License

Apache-2.0
