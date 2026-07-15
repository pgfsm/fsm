import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { configureWorkerLogger } from "../logger.ts";
import { runAsyncOperationScheduler } from "../asyncOperationScheduler/asyncOperationScheduler.ts";
import type { AsyncOperationSchedulerOptions } from "../asyncOperationScheduler/asyncOperationScheduler.ts";

const logger = getLogger(["@pgfsm/scheduler", "async-operation", "cli"]);
await configureWorkerLogger();

const args = parseArgs(Deno.args, {
  string: ["db-url", "poll-interval", "stale-threshold"],
  boolean: ["help"],
  alias: {
    h: "help",
    d: "db-url",
    p: "poll-interval",
    s: "stale-threshold",
  },
});

function printHelp(): void {
  logger.info(`
async-operation-scheduler — async-operation dispatch scheduler (kube-scheduler equivalent)

USAGE
  deno run --allow-all src/cli/async-operation-scheduler.ts [options]

OPTIONS
  -d, --db-url <url>             Database connection URL (overrides DATABASE_URL from .env)
  -p, --poll-interval <ms>       Fallback poll interval in milliseconds (default: 30000)
  -s, --stale-threshold <secs>   Seconds before a workerlet is considered dead (default: 30)
  -h, --help                     Show this help message

DESCRIPTION
  Listens on the 'async_operation_scheduler_work' pg_notify channel. When a
  dispatch entry appears in async_operation_instance_and_async_operation_workerlet,
  runs a scheduling cycle: SELECT FOR UPDATE SKIP LOCKED, filter+score active
  async-operation workerlets, UPDATE to 'scheduled', pg_notify the winning
  workerlet. A fallback poll runs every 30 s for missed notifications.
  Run on the control plane alongside the API server — NOT on workerlet nodes.
`);
}

if (args.help) {
  printHelp();
  Deno.exit(0);
}

dotenv.config({ path: ".env" });
const resolvedDbUrl = args["db-url"] ?? Deno.env.get("DATABASE_URL") ?? "";

if (!resolvedDbUrl) {
  logger.error("DATABASE_URL is required (set in .env or pass --db-url)");
  Deno.exit(1);
}

const pollIntervalArg = args["poll-interval"];
const pollIntervalMs = pollIntervalArg ? Number(pollIntervalArg) : undefined;
if (
  pollIntervalMs !== undefined &&
  (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1)
) {
  logger.error("--poll-interval must be a positive integer, got: {value}", {
    value: pollIntervalArg,
  });
  Deno.exit(1);
}

const staleThresholdArg = args["stale-threshold"];
const staleThresholdSeconds = staleThresholdArg
  ? Number(staleThresholdArg)
  : undefined;
if (
  staleThresholdSeconds !== undefined &&
  (!Number.isInteger(staleThresholdSeconds) || staleThresholdSeconds < 1)
) {
  logger.error("--stale-threshold must be a positive integer, got: {value}", {
    value: staleThresholdArg,
  });
  Deno.exit(1);
}

const options: AsyncOperationSchedulerOptions = {
  pollIntervalMs,
  staleThresholdSeconds,
};

const controller = new AbortController();
let shutdownRequested = false;

const onSignal = () => {
  if (shutdownRequested) {
    logger.info("Force exit.");
    Deno.exit(0);
  }
  shutdownRequested = true;
  logger.info(
    "Shutdown requested — stopping async-operation scheduler gracefully. Ctrl+C again to force exit...",
  );
  controller.abort();
};

Deno.addSignalListener("SIGINT", onSignal);
Deno.addSignalListener("SIGTERM", onSignal);

try {
  await runAsyncOperationScheduler(
    { connectionString: resolvedDbUrl, max: 4 },
    { ...options, signal: controller.signal },
  );
  logger.info("Async-operation scheduler stopped.");
} catch (err) {
  logger.error("Async-operation scheduler failed: {error}", { error: err });
  Deno.exit(1);
}
