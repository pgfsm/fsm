import { parseArgs } from "@std/cli/parse-args";
import { getLogger } from "@logtape/logtape";
import { runFsmScheduler } from "../scheduler/fsmscheduler.ts";
import { CLI_INVOCATION } from "../invocation.ts";
import { CTL_CATEGORY } from "../logger.ts";
import { resolveDbUrl } from "./db.ts";

const logger = getLogger([CTL_CATEGORY, "scheduler"]);

const HELP =
  `pgfsmctl scheduler — the standing fsmscheduler process (FALLBACK ONLY)

USAGE
  ${CLI_INVOCATION} scheduler run [options]

  pg_cron is the primary dispatch scheduler (SPEC-003): register it once with
  \`${CLI_INVOCATION} pgcron register\`. This long-running process is kept
  only as a fallback safety net until pg_cron is trusted as the sole
  mechanism; running both is safe, just redundant.

OPTIONS
  -p, --poll-interval <ms>       Fallback poll interval in milliseconds (default: 30000)
  -s, --stale-threshold <secs>   Seconds before a fsmlet is considered dead (default: 30)
  -d, --db-url <url>             Database connection URL (overrides DATABASE_URL from .env)
  -h, --help                     Show this help

DESCRIPTION
  Polls (and LISTENs on the 'fsm_scheduler_work' channel, which nothing
  notifies since SPEC-003) and runs scheduling cycles: SELECT FOR UPDATE SKIP
  LOCKED, filter+score active fsmlets, UPDATE to 'scheduled', pg_notify the
  winning fsmlet. Run on the control plane — NOT on fsmlet nodes.
`;

function positiveInt(flag: string, value: string | undefined) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    logger.error(`${flag} must be a positive integer, got: {value}`, {
      value,
    });
    Deno.exit(1);
  }
  return n;
}

export async function schedulerCommand(argv: string[]): Promise<void> {
  const args = parseArgs(argv, {
    string: ["db-url", "poll-interval", "stale-threshold"],
    boolean: ["help"],
    alias: { h: "help", d: "db-url", p: "poll-interval", s: "stale-threshold" },
  });

  if (args.help) {
    console.log(HELP);
    Deno.exit(0);
  }
  const verb = args._[0] === undefined ? undefined : String(args._[0]);
  if (verb !== "run") {
    logger.error(
      verb === undefined
        ? "scheduler needs a verb: run"
        : `Unknown scheduler verb: ${verb}`,
    );
    console.log(HELP);
    Deno.exit(1);
  }

  const pollIntervalMs = positiveInt("--poll-interval", args["poll-interval"]);
  const staleThresholdSeconds = positiveInt(
    "--stale-threshold",
    args["stale-threshold"],
  );
  const dbUrl = resolveDbUrl(args["db-url"]);

  logger.warning(
    "scheduler run is a fallback: pg_cron (`pgcron register`) is the primary scheduler (SPEC-003).",
  );

  const controller = new AbortController();
  let shutdownRequested = false;
  const onSignal = () => {
    if (shutdownRequested) {
      logger.info("Force exit.");
      Deno.exit(0);
    }
    shutdownRequested = true;
    logger.info(
      "Shutdown requested — stopping the scheduler gracefully. Ctrl+C again to force exit...",
    );
    controller.abort();
  };
  Deno.addSignalListener("SIGINT", onSignal);
  Deno.addSignalListener("SIGTERM", onSignal);

  try {
    await runFsmScheduler(
      { connectionString: dbUrl, max: 4 },
      { pollIntervalMs, staleThresholdSeconds, signal: controller.signal },
    );
    logger.info("Scheduler stopped.");
  } catch (err) {
    logger.error("Scheduler failed: {error}", { error: err });
    Deno.exit(1);
  }
}
