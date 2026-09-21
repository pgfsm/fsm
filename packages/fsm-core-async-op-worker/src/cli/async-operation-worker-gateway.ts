import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";
import { Pool } from "pg";
import { getLogger } from "@logtape/logtape";
import { CATEGORY, configureLogging, isTerminal } from "@pgfsm/logging";
import type { DBDeps } from "@pgfsm/db";
import { startActivityGatewayServer } from "../index.ts";
import { CLI_INVOCATION } from "./gateway-invocation.ts";
import { PACKAGE_VERSION } from "./version.ts";

dotenv.config({ path: ".env" });

const logger = getLogger(["@pgfsm/worker", "async-op-worker-gateway", "cli"]);
// Composition root for this CLI: configures LogTape once, same pattern as
// apps/fsm-core-worker-ts/src/logger.ts's configureWorkerLogger.
await configureLogging({
  levels: { [CATEGORY.worker]: isTerminal ? "debug" : "info" },
});

const args = parseArgs(Deno.args, {
  string: [
    "bind",
    "sidecar-socket",
    "invoke-timeout-ms",
    "db-url",
    "poll-interval-ms",
  ],
  boolean: [
    "help",
    "version",
    "disable-poll-loop",
    "ensure-queue-on-register",
  ],
  alias: {
    h: "help",
    v: "version",
    b: "bind",
    s: "sidecar-socket",
    t: "invoke-timeout-ms",
    d: "db-url",
  },
});

if (args.version) {
  // Bare, undecorated output (no logger timestamp/category prefix) so
  // `$(async-operation-worker-gateway --version)` stays script-friendly,
  // matching @pgfsm/compiler's --version convention (#258).
  console.log(PACKAGE_VERSION);
  Deno.exit(0);
}

function printHelp(): void {
  logger.info(`
async-operation-worker-gateway — standalone async-op worker: Activity Gateway
+ 30s Postgres poll loop for compiled-language async-operation actors

USAGE
  ${CLI_INVOCATION} [options]

OPTIONS
  -b, --bind <target>              gRPC bind target (default: unix:/tmp/pgfsm-activity-gateway.sock)
  -s, --sidecar-socket <path>      Unix socket path workers connect to (default: /tmp/pgfsm-activity-gateway-workers.sock)
  -t, --invoke-timeout-ms <ms>     Default per-invoke timeout (default: 10000)
  -d, --db-url <url>               Database connection URL (overrides DATABASE_URL from .env)
  --poll-interval-ms <ms>          Async-op poll loop interval (default: 30000)
  --disable-poll-loop              Don't start the poll loop -- gateway/sidecar only
  --ensure-queue-on-register       Ensure a PGMQ queue exists for every actor a worker registers (default: off)
  -v, --version                    Print @pgfsm/async-worker's version and exit
  -h, --help                       Show this help message

DESCRIPTION
  Starts the Activity Gateway: a gRPC service (client-facing) backed by a
  Unix-socket sidecar (worker-facing). Compiled-language worker processes
  connect to the sidecar socket and register the actors they serve.

  Unless --disable-poll-loop is set, this process also owns its own Postgres
  connection and drives internalAsyncOperation-type async operations for its
  currently-registered actors itself, on a 30-second poll (see
  asyncOpPollLoop.ts / GOAL.md) -- a standalone alternative to
  fsm-async-worker-ts's poll/claim/archive loop, not something that needs it
  running alongside this process.

  With --ensure-queue-on-register, every actor a worker registers also gets
  a PGMQ queue ensured to exist (idempotent). asyncOperationType is always
  shortened to its first character; when asyncOperationType is exactly
  "internalAsyncOperation", asyncOperationVersion is dropped and
  asyncOperationLanguage is also shortened to its first character:
    asyncOperationType "internalAsyncOperation":  <parentFsmName>_<parentFsmVersion>_<asyncOperationType[0]>_<asyncOperationName>_<asyncOperationLanguage[0]>
    otherwise:                                    <parentFsmName>_<parentFsmVersion>_<asyncOperationType[0]>_<asyncOperationName>_<asyncOperationVersion>_<asyncOperationLanguage>
  PGMQ enforces a 48-character limit on that name -- long identities can
  still exceed it (more likely on the non-"internalAsyncOperation" path) and will fail
  this step (registration itself still succeeds; only the queue-ensure call
  fails, logged as an error).
`);
}

if (args.help) {
  printHelp();
  Deno.exit(0);
}

const bindTarget = args.bind ?? "unix:/tmp/pgfsm-activity-gateway.sock";
const sidecarSocketPath = args["sidecar-socket"] ??
  "/tmp/pgfsm-activity-gateway-workers.sock";
const invokeTimeoutArg = args["invoke-timeout-ms"];
const defaultInvokeTimeoutMs = invokeTimeoutArg
  ? Number(invokeTimeoutArg)
  : undefined;

if (invokeTimeoutArg && !Number.isInteger(defaultInvokeTimeoutMs)) {
  logger.error("--invoke-timeout-ms must be a positive integer, got: {value}", {
    value: invokeTimeoutArg,
  });
  Deno.exit(1);
}

const pollLoopEnabled = !args["disable-poll-loop"];
const ensureQueueOnRegisterEnabled = !!args["ensure-queue-on-register"];
const needsDb = pollLoopEnabled || ensureQueueOnRegisterEnabled;

let dbPool: Pool | undefined;
let asyncOpPollLoopOption:
  | { deps: DBDeps; intervalMs?: number; invokeTimeoutMs?: number }
  | undefined;
let ensureQueueOnRegisterOption: { deps: DBDeps } | undefined;

if (needsDb) {
  const resolvedDbUrl = args["db-url"] ?? Deno.env.get("DATABASE_URL") ?? "";
  if (!resolvedDbUrl) {
    logger.error(
      "DATABASE_URL is required for the poll loop and/or --ensure-queue-on-register (set in .env or pass --db-url), or pass --disable-poll-loop (and omit --ensure-queue-on-register) to run the gateway/sidecar only",
    );
    Deno.exit(1);
  }
  dbPool = new Pool({ connectionString: resolvedDbUrl });
  const deps: DBDeps = { db: dbPool, useSupabase: false };

  if (pollLoopEnabled) {
    const pollIntervalArg = args["poll-interval-ms"];
    const pollIntervalMs = pollIntervalArg
      ? Number(pollIntervalArg)
      : undefined;
    if (pollIntervalArg && !Number.isInteger(pollIntervalMs)) {
      logger.error(
        "--poll-interval-ms must be a positive integer, got: {value}",
        { value: pollIntervalArg },
      );
      Deno.exit(1);
    }
    asyncOpPollLoopOption = {
      deps,
      intervalMs: pollIntervalMs,
      invokeTimeoutMs: defaultInvokeTimeoutMs,
    };
  }

  if (ensureQueueOnRegisterEnabled) {
    ensureQueueOnRegisterOption = { deps };
  }
}

const controller = new AbortController();
let shutdownRequested = false;

const onSignal = () => {
  if (shutdownRequested) {
    logger.info("Force exit.");
    Deno.exit(0);
  }
  shutdownRequested = true;
  logger.info(
    "Shutdown requested — stopping activity gateway gracefully. Ctrl+C again to force exit...",
  );
  controller.abort();
};

Deno.addSignalListener("SIGINT", onSignal);
Deno.addSignalListener("SIGTERM", onSignal);

try {
  logger.info(
    "Starting activity gateway: bind={bind}, sidecar-socket={socket}, pollLoop={pollLoop}, ensureQueueOnRegister={ensureQueueOnRegister}",
    {
      bind: bindTarget,
      socket: sidecarSocketPath,
      pollLoop: pollLoopEnabled,
      ensureQueueOnRegister: ensureQueueOnRegisterEnabled,
    },
  );
  await startActivityGatewayServer({
    bindTarget,
    sidecarSocketPath,
    defaultInvokeTimeoutMs,
    signal: controller.signal,
    asyncOpPollLoop: asyncOpPollLoopOption,
    ensureQueueOnRegister: ensureQueueOnRegisterOption,
  });
  logger.info("Activity gateway stopped.");
} catch (err) {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  logger.error("Activity gateway failed: {error}", { error: msg });
  Deno.exit(1);
} finally {
  if (dbPool) {
    await dbPool.end();
  }
}
