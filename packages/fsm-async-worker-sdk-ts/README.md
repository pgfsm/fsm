# @pgfsm/async-worker-sdk

TypeScript worker SDK for the pgfsm Activity Gateway. A worker process built on
it connects to the gateway's sidecar Unix socket, registers a set of actors, and
serves the invocations the gateway routes to them over the
`pgfsm.sidecargateway.v1.SidecarGatewayService` gRPC stream (stubs from
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
```

### CLI options (`runActorWorkerCli`)

| Flag                          | Default                                    | Meaning                      |
| ----------------------------- | ------------------------------------------ | ---------------------------- |
| `-g, --gateway-socket <path>` | `/tmp/pgfsm-activity-gateway-workers.sock` | Sidecar socket to connect to |
| `-i, --worker-id <id>`        | `typescript-<random>`                      | Stable worker identity       |
| `--heartbeat-ms <ms>`         | `5000`                                     | Heartbeat interval           |
| `-h, --help`                  |                                            | Show help                    |

`runActorWorkerCli` resolves to an exit code (0 or 1) rather than exiting, and
stops the worker gracefully on SIGINT/SIGTERM.

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
await worker.run(); // resolves when the stream ends or worker.stop() is called
```

A handler that throws is reported to the gateway as an `INTERNAL` invoke error;
an invoke for an actor this worker didn't register is reported as `NOT_FOUND`.

## License

Apache-2.0
