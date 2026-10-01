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
import {
  type ActorRegistration,
  ActorWorker,
  DEFAULT_KEEPALIVE_INTERVAL_MS,
  DEFAULT_KEEPALIVE_TIMEOUT_MS,
  DEFAULT_RECONNECT_INITIAL_DELAY_MS,
  DEFAULT_RECONNECT_MAX_DELAY_MS,
  DEFAULT_SHUTDOWN_GRACE_MS,
  parseGatewayAddress,
} from "./actorWorker.ts";

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
  -a, --gateway-address <addr>  Gateway sidecar address instead: unix:<path>, https://host:port,
                                or http://host:port (the gateway's --insecure-plaintext test mode)
      --gateway-ca-file <file>  PEM CA bundle to trust the gateway's TLS certificate (default: system roots)
      --gateway-token-file <file>
                                Bearer token sent to the gateway; re-read on every reconnect
      --gateway-cert-file <file>
      --gateway-key-file <file> Client certificate and key for mutual TLS
  -c, --max-concurrency <n>     Invokes of each actor run at once, for actors without their own
                                maxConcurrency (default: 1). Handlers must be concurrency-safe above 1.
      --keepalive-interval-ms <ms>
                                HTTP/2 PING interval over TCP (default: ${DEFAULT_KEEPALIVE_INTERVAL_MS}; 0 disables)
      --keepalive-timeout-ms <ms>
                                Reconnect when a PING goes unanswered this long (default: ${DEFAULT_KEEPALIVE_TIMEOUT_MS})
      --shutdown-grace-ms <ms>  On SIGINT/SIGTERM, let in-flight invokes finish this long (default: ${DEFAULT_SHUTDOWN_GRACE_MS})
  -i, --worker-id <id>          Stable worker identity (default: typescript-<random>)
      --heartbeat-ms <ms>       Heartbeat interval (default: 5000)
      --reconnect-initial-delay-ms <ms>
                                First reconnect backoff step (default: ${DEFAULT_RECONNECT_INITIAL_DELAY_MS})
      --reconnect-max-delay-ms <ms>
                                Reconnect backoff cap (default: ${DEFAULT_RECONNECT_MAX_DELAY_MS})
      --reconnect-max-attempts <n>
                                Exit after n consecutive failed attempts (default: 0 = retry forever)
  -h, --help                    Show this help message

COMMANDS
  list    Print the actors compiled into this registry, without connecting to the gateway.
  start   Connect to the gateway and serve invocations for every actor in the registry until stopped.
          Waits for the gateway if it isn't up yet, and reconnects and re-registers if the
          session drops (e.g. the gateway restarts). On SIGINT/SIGTERM it drains: new invokes
          are refused as retriable while in-flight ones finish.

DESCRIPTION
  Actors come from a compiler-generated registry (see
  fsm-compiler-ts's writeAggregateActorsRegistry) -- statically imported at
  build time, not scanned or dynamically loaded at startup.

EXAMPLES
  ${invocation} start --gateway-socket ${DEFAULT_GATEWAY_SOCKET_PATH}
  ${invocation} start --gateway-address https://activity-gateway:7443 \\
    --gateway-ca-file ca.crt --gateway-token-file token --max-concurrency 10
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
    string: [
      "gateway-socket",
      "gateway-address",
      "gateway-ca-file",
      "gateway-token-file",
      "gateway-cert-file",
      "gateway-key-file",
      "max-concurrency",
      "keepalive-interval-ms",
      "keepalive-timeout-ms",
      "shutdown-grace-ms",
      "worker-id",
      "heartbeat-ms",
      "reconnect-initial-delay-ms",
      "reconnect-max-delay-ms",
      "reconnect-max-attempts",
    ],
    boolean: ["help"],
    alias: {
      h: "help",
      g: "gateway-socket",
      a: "gateway-address",
      c: "max-concurrency",
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

  /** An integer flag ≥ `min`, or undefined when not given; null if invalid. */
  const integerFlag = (
    name: string,
    min: number,
  ): number | undefined | null => {
    const raw = args[name as keyof typeof args] as string | undefined;
    if (raw === undefined) return undefined;
    // An empty value (`--flag=`, or `--flag -1`, which parses `-1` as a
    // separate flag) must not read as 0.
    const value = raw.trim() === "" ? NaN : Number(raw);
    if (!Number.isInteger(value) || value < min) {
      logger.error("--{name} must be an integer ≥ {min}, got: {value}", {
        name,
        min,
        value: raw,
      });
      return null;
    }
    return value;
  };

  if (args["gateway-socket"] && args["gateway-address"]) {
    logger.error("Pass either --gateway-socket or --gateway-address, not both");
    return 1;
  }
  const gatewayAddress = args["gateway-address"] ??
    `unix:${args["gateway-socket"] ?? DEFAULT_GATEWAY_SOCKET_PATH}`;
  try {
    parseGatewayAddress(gatewayAddress);
  } catch (error) {
    logger.error("{error}", {
      error: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
  const caFile = args["gateway-ca-file"];
  const tokenFile = args["gateway-token-file"];
  const certFile = args["gateway-cert-file"];
  const keyFile = args["gateway-key-file"];
  if (!!certFile !== !!keyFile) {
    logger.error("--gateway-cert-file and --gateway-key-file go together");
    return 1;
  }
  // Fail fast on unreadable credentials instead of retrying forever.
  for (
    const [flag, file] of Object.entries({
      caFile,
      tokenFile,
      certFile,
      keyFile,
    })
  ) {
    if (!file) continue;
    try {
      Deno.statSync(file);
    } catch {
      logger.error("Can't read {flag} file {file}", { flag, file });
      return 1;
    }
  }
  const maxConcurrency = integerFlag("max-concurrency", 1);
  const keepaliveIntervalMs = integerFlag("keepalive-interval-ms", 0);
  const keepaliveTimeoutMs = integerFlag("keepalive-timeout-ms", 1);
  const shutdownGraceMs = integerFlag("shutdown-grace-ms", 0);
  if (
    [maxConcurrency, keepaliveIntervalMs, keepaliveTimeoutMs, shutdownGraceMs]
      .includes(null)
  ) {
    return 1;
  }
  const workerId = args["worker-id"] ??
    `typescript-${crypto.randomUUID().slice(0, 8)}`;
  const heartbeatMs = args["heartbeat-ms"]
    ? Number(args["heartbeat-ms"])
    : undefined;
  const reconnectInitialDelayMs = args["reconnect-initial-delay-ms"]
    ? Number(args["reconnect-initial-delay-ms"])
    : undefined;
  const reconnectMaxDelayMs = args["reconnect-max-delay-ms"]
    ? Number(args["reconnect-max-delay-ms"])
    : undefined;
  const reconnectMaxAttempts = args["reconnect-max-attempts"]
    ? Number(args["reconnect-max-attempts"])
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
    {
      workerId,
      language: "typescript",
      gatewayAddress,
      caFile,
      tokenFile,
      certFile,
      keyFile,
      maxConcurrency: maxConcurrency ?? undefined,
      keepaliveIntervalMs: keepaliveIntervalMs ?? undefined,
      keepaliveTimeoutMs: keepaliveTimeoutMs ?? undefined,
      shutdownGraceMs: shutdownGraceMs ?? undefined,
      heartbeatMs,
      reconnectInitialDelayMs,
      reconnectMaxDelayMs,
      reconnectMaxAttempts,
    },
    registrations,
  );

  let stopRequested = false;
  const onSignal = () => {
    if (stopRequested) {
      logger.info("Already stopping: waiting for in-flight invokes to finish");
      return;
    }
    stopRequested = true;
    logger.info("Shutdown requested — draining and stopping worker...");
    void worker.stop();
  };
  Deno.addSignalListener("SIGINT", onSignal);
  Deno.addSignalListener("SIGTERM", onSignal);

  try {
    logger.info(
      "Starting worker {workerId}: gateway={address}",
      { workerId, address: gatewayAddress },
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
