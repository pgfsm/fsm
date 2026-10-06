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
  /**
   * Reads an environment variable; defaults to `Deno.env.get`. Every option
   * falls back to its variable (see `envVarFor`) when the flag isn't given.
   */
  env?: (name: string) => string | undefined;
}

/**
 * The options that fall back to an environment variable, by long name. Same
 * list, names and precedence (flag → variable → default) in all four SDKs.
 */
export const ENV_OPTIONS = [
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
] as const;

/** `PGFSM_` + the long option name upper-cased, `-` → `_`. */
export function envVarFor(option: string): string {
  return `PGFSM_${option.toUpperCase().replaceAll("-", "_")}`;
}

function defaultEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    // No --allow-env: behave as if nothing is set.
    return undefined;
  }
}

/** Everything `start` needs, resolved from flags, then variables, then defaults. */
export interface CliSettings {
  gatewayAddress: string;
  caFile?: string;
  tokenFile?: string;
  certFile?: string;
  keyFile?: string;
  maxConcurrency?: number;
  keepaliveIntervalMs?: number;
  keepaliveTimeoutMs?: number;
  shutdownGraceMs?: number;
  workerId?: string;
  heartbeatMs?: number;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectMaxAttempts?: number;
}

/**
 * Resolves the options from parsed flags (long names → raw strings) and the
 * environment: a flag wins over its variable, which wins over the default. An
 * empty variable counts as unset. Returns an error message (naming the flag or
 * variable it came from) for anything invalid, so `start` can exit 1 before
 * connecting.
 */
export function resolveSettings(
  flags: Partial<Record<(typeof ENV_OPTIONS)[number], string>>,
  env: (name: string) => string | undefined,
): CliSettings | { error: string } {
  const fromEnv = (option: (typeof ENV_OPTIONS)[number]) => {
    const value = env(envVarFor(option));
    return value === undefined || value === "" ? undefined : value;
  };
  /** The raw value and where it came from, or undefined when unset. */
  const setting = (option: (typeof ENV_OPTIONS)[number]) => {
    if (flags[option] !== undefined) {
      return { raw: flags[option]!, label: `--${option}` };
    }
    const value = fromEnv(option);
    return value === undefined
      ? undefined
      : { raw: value, label: envVarFor(option) };
  };
  /** An integer ≥ `min`, or undefined when unset; an error if invalid. */
  const integer = (
    option: (typeof ENV_OPTIONS)[number],
    min: number,
  ): number | undefined | { error: string } => {
    const found = setting(option);
    if (!found) return undefined;
    // An empty value (`--flag=`, or `--flag -1`, which parses `-1` as a
    // separate flag) must not read as 0.
    const value = found.raw.trim() === "" ? NaN : Number(found.raw);
    if (!Number.isInteger(value) || value < min) {
      return {
        error: `${found.label} must be an integer ≥ ${min}, got: ${found.raw}`,
      };
    }
    return value;
  };

  // Where the gateway is counts as one setting: a flag for either form
  // overrides both variables.
  let gatewayAddress: string;
  const level = flags["gateway-socket"] !== undefined ||
      flags["gateway-address"] !== undefined
    ? { socket: flags["gateway-socket"], address: flags["gateway-address"] }
    : {
      socket: fromEnv("gateway-socket"),
      address: fromEnv("gateway-address"),
    };
  if (level.socket && level.address) {
    const fromFlags = flags["gateway-socket"] !== undefined ||
      flags["gateway-address"] !== undefined;
    return {
      error: fromFlags
        ? "Pass either --gateway-socket or --gateway-address, not both"
        : `Set either ${envVarFor("gateway-socket")} or ${
          envVarFor("gateway-address")
        }, not both`,
    };
  }
  if (level.address) {
    gatewayAddress = level.address;
    try {
      parseGatewayAddress(gatewayAddress);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  } else {
    gatewayAddress = `unix:${level.socket ?? DEFAULT_GATEWAY_SOCKET_PATH}`;
  }

  const files = {
    caFile: setting("gateway-ca-file"),
    tokenFile: setting("gateway-token-file"),
    certFile: setting("gateway-cert-file"),
    keyFile: setting("gateway-key-file"),
  };
  if (!!files.certFile !== !!files.keyFile) {
    return {
      error: "--gateway-cert-file and --gateway-key-file go together " +
        `(or ${envVarFor("gateway-cert-file")} and ${
          envVarFor("gateway-key-file")
        })`,
    };
  }
  // Fail fast on unreadable credentials instead of retrying forever.
  for (const found of Object.values(files)) {
    if (!found) continue;
    try {
      Deno.statSync(found.raw);
    } catch {
      return { error: `Can't read ${found.label} file ${found.raw}` };
    }
  }

  const numbers = {
    maxConcurrency: integer("max-concurrency", 1),
    keepaliveIntervalMs: integer("keepalive-interval-ms", 0),
    keepaliveTimeoutMs: integer("keepalive-timeout-ms", 1),
    shutdownGraceMs: integer("shutdown-grace-ms", 0),
    heartbeatMs: integer("heartbeat-ms", 1),
    reconnectInitialDelayMs: integer("reconnect-initial-delay-ms", 1),
    reconnectMaxDelayMs: integer("reconnect-max-delay-ms", 1),
    reconnectMaxAttempts: integer("reconnect-max-attempts", 0),
  };
  for (const value of Object.values(numbers)) {
    if (typeof value === "object") return value;
  }
  const n = numbers as Record<keyof typeof numbers, number | undefined>;

  return {
    gatewayAddress,
    caFile: files.caFile?.raw,
    tokenFile: files.tokenFile?.raw,
    certFile: files.certFile?.raw,
    keyFile: files.keyFile?.raw,
    workerId: setting("worker-id")?.raw,
    ...n,
  };
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

ENVIRONMENT
  Every option above except --help falls back to an environment variable when the flag
  isn't given: PGFSM_ + the long name in upper case, with - as _. A flag wins over its
  variable; an empty variable counts as unset. Credentials stay file paths.
    ${ENV_OPTIONS.map(envVarFor).join("\n    ")}

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

  const flags: Partial<Record<(typeof ENV_OPTIONS)[number], string>> = {};
  for (const option of ENV_OPTIONS) {
    const value = args[option as keyof typeof args];
    if (typeof value === "string") flags[option] = value;
  }
  const settings = resolveSettings(flags, options.env ?? defaultEnv);
  if ("error" in settings) {
    logger.error("{error}", { error: settings.error });
    return 1;
  }
  const workerId = settings.workerId ??
    `typescript-${crypto.randomUUID().slice(0, 8)}`;
  const { gatewayAddress } = settings;

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
      ...settings,
      workerId,
      language: "typescript",
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
