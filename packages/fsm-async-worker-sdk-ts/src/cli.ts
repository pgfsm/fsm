// `list`/`start` command handling for a compiler-generated
// `run-async-worker.ts` — moved here from fsm-compiler-ts's
// worker-sdk-cli.eta (#358), which used to write this whole file into every
// project as `async-worker/typescript/cli.ts`.
//
// Logging is not configured here: like every other library in this repo,
// this module only calls `getLogger()`. The generated entry point calls
// `@pgfsm/logging`'s `configureLogging()` once before calling this (see
// packages/fsm-compiler-ts's run-async-worker.eta).

import { parseArgs } from "@std/cli/parse-args";
import { getLogger } from "@logtape/logtape";
import { type ActorRegistration, ActorWorker } from "./actorWorker.ts";

const logger = getLogger([
  "@pgfsm/worker",
  "async-op-worker-gateway",
  "worker-sdk-ts",
  "cli",
]);

export const DEFAULT_GATEWAY_SOCKET_PATH =
  "/tmp/pgfsm-activity-gateway-workers.sock";

export interface RunActorWorkerCliOptions {
  /** The compiler-generated registry's `ACTOR_REGISTRATIONS`. */
  registrations: ActorRegistration[];
  /** Command-line arguments, usually `Deno.args`. */
  args: string[];
  /**
   * How to run the calling script, shown in `--help`. Defaults to
   * `deno run --allow-all run-async-worker.ts`.
   */
  invocation?: string;
}

function printHelp(invocation: string): void {
  logger.info(`
@pgfsm/async-worker-sdk — TypeScript worker for the Activity Gateway

USAGE
  ${invocation} <list|start> [options]

OPTIONS
  -g, --gateway-socket <path>   Sidecar socket to connect to (default: ${DEFAULT_GATEWAY_SOCKET_PATH})
  -i, --worker-id <id>          Stable worker identity (default: typescript-<random>)
      --heartbeat-ms <ms>       Heartbeat interval (default: 5000)
  -h, --help                    Show this help message

COMMANDS
  list    Print the actors compiled into this registry, without connecting to the gateway.
  start   Connect to the gateway and serve invocations for every actor in the registry until stopped.

DESCRIPTION
  Actors come from a compiler-generated registry (see
  fsm-compiler-ts's writeAggregateActorsRegistry) -- statically imported at
  build time, not scanned or dynamically loaded at startup.

EXAMPLE
  ${invocation} start --gateway-socket ${DEFAULT_GATEWAY_SOCKET_PATH}
`);
}

/**
 * Runs the `list`/`start` worker CLI against `registrations` and resolves
 * to the process exit code — the caller decides whether to `Deno.exit()`
 * with it, which keeps this testable. `start` installs SIGINT/SIGTERM
 * listeners that stop the worker gracefully and removes them once it
 * returns.
 */
export async function runActorWorkerCli(
  options: RunActorWorkerCliOptions,
): Promise<number> {
  const { registrations } = options;
  const invocation = options.invocation ??
    "deno run --allow-all run-async-worker.ts";

  const args = parseArgs(options.args, {
    string: ["gateway-socket", "worker-id", "heartbeat-ms"],
    boolean: ["help"],
    alias: {
      h: "help",
      g: "gateway-socket",
      i: "worker-id",
    },
  });

  if (args.help) {
    printHelp(invocation);
    return 0;
  }

  const command = String(args._[0] ?? "");
  if (command !== "list" && command !== "start") {
    logger.error("First argument must be one of: list, start. Got: {command}", {
      command: command || "(none)",
    });
    printHelp(invocation);
    return 1;
  }

  const gatewaySocketPath = args["gateway-socket"] ??
    DEFAULT_GATEWAY_SOCKET_PATH;
  const workerId = args["worker-id"] ??
    `typescript-${crypto.randomUUID().slice(0, 8)}`;
  const heartbeatMs = args["heartbeat-ms"]
    ? Number(args["heartbeat-ms"])
    : undefined;

  logger.info("{count} actor(s) compiled into this registry", {
    count: registrations.length,
  });
  for (const reg of registrations) {
    logger.info(
      "  + {asyncOperationName}@{asyncOperationVersion} (parent {parentFsmName}@{parentFsmVersion})",
      {
        asyncOperationName: reg.asyncOperationName,
        asyncOperationVersion: reg.asyncOperationVersion,
        parentFsmName: reg.parentFsmName,
        parentFsmVersion: reg.parentFsmVersion,
      },
    );
  }

  if (command === "list") {
    return 0;
  }

  if (registrations.length === 0) {
    logger.error("No actors in the registry, refusing to start worker");
    return 1;
  }

  const worker = new ActorWorker(
    { workerId, language: "typescript", gatewaySocketPath, heartbeatMs },
    registrations,
  );

  const onSignal = () => {
    logger.info("Shutdown requested — stopping worker...");
    worker.stop();
  };
  Deno.addSignalListener("SIGINT", onSignal);
  Deno.addSignalListener("SIGTERM", onSignal);

  try {
    logger.info(
      "Starting worker {workerId}: gateway-socket={socket}",
      { workerId, socket: gatewaySocketPath },
    );
    await worker.run();
    logger.info("Worker {workerId} stopped.", { workerId });
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    logger.error("Worker {workerId} failed: {error}", { workerId, error: msg });
    return 1;
  } finally {
    Deno.removeSignalListener("SIGINT", onSignal);
    Deno.removeSignalListener("SIGTERM", onSignal);
  }
}
