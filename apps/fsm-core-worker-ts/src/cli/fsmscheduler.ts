import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { configureWorkerLogger } from "../logger.ts";
import { runFsmScheduler } from "../scheduler/fsm-scheduler.ts";
import type { FsmSchedulerOptions } from "../scheduler/fsm-scheduler.ts";

const logger = getLogger(["@pgfsm/scheduler", "cli"]);
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
fsmscheduler — FSM dispatch scheduler (kube-scheduler equivalent)

USAGE
  deno run --allow-all src/cli/fsmscheduler.ts [options]

OPTIONS
  -d, --db-url <url>             Database connection URL (overrides DATABASE_URL from .env)
  -p, --poll-interval <ms>       Staging queue poll interval in milliseconds (default: 500)
  -s, --stale-threshold <secs>   Seconds before a fsmlet is considered dead (default: 30)
  -h, --help                     Show this help message

DESCRIPTION
  Listens on the 'fsm_scheduler_work' pg_notify channel. When a dispatch entry
  appears in fsm_dispatch_queue, runs a scheduling cycle: SELECT FOR UPDATE SKIP
  LOCKED, filter+score active fsmlets, UPDATE to 'scheduled', pg_notify the
  winning fsmlet. A fallback poll runs every 30 s for missed notifications.
  Run on the control plane alongside the API server — NOT on fsmlet nodes.
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

const options: FsmSchedulerOptions = {
  pollIntervalMs: args["poll-interval"] ? Number(args["poll-interval"]) : undefined,
  staleThresholdSeconds: args["stale-threshold"] ? Number(args["stale-threshold"]) : undefined,
};

const controller = new AbortController();
let shutdownRequested = false;

const onSignal = () => {
  if (shutdownRequested) {
    logger.info("Force exit.");
    Deno.exit(0);
  }
  shutdownRequested = true;
  logger.info("Shutdown requested — stopping fsmscheduler gracefully. Ctrl+C again to force exit...");
  controller.abort();
};

Deno.addSignalListener("SIGINT", onSignal);
Deno.addSignalListener("SIGTERM", onSignal);

try {
  await runFsmScheduler(
    { connectionString: resolvedDbUrl, max: 4 },
    { ...options, signal: controller.signal },
  );
  logger.info("Fsmscheduler stopped.");
} catch (err) {
  logger.error("Fsmscheduler failed: {error}", { error: err });
  Deno.exit(1);
}
