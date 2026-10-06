import { getLogger } from "@logtape/logtape";
import { runFsmScheduler } from "../scheduler/fsmscheduler.ts";
import { parseCommandArgs, verbOf } from "../args.ts";
import { resolveDbUrl } from "../db-target.ts";
import { ExitCode, usageError } from "../exit.ts";
import { CLI_INVOCATION } from "../invocation.ts";
import { CTL_CATEGORY } from "../logger.ts";

const logger = getLogger([CTL_CATEGORY, "scheduler"]);

const HELP =
  `pgfsmctl scheduler — the standing fsmscheduler process (FALLBACK ONLY)

USAGE
  ${CLI_INVOCATION} scheduler run [options]

  pg_cron is the primary dispatch scheduler (SPEC-003): register it once with
  \`${CLI_INVOCATION} db cron register\`. This long-running process is kept
  only as a fallback safety net until pg_cron is trusted as the sole
  mechanism; running both is safe, just redundant.

OPTIONS
  -p, --poll-interval <ms>       Fallback poll interval in milliseconds (default: 30000)
  -s, --stale-threshold <secs>   Seconds before a fsmlet is considered dead (default: 30)
  -d, --db-url <url>             Postgres URL (else --profile, PGFSM_DB_URL, DATABASE_URL, current profile)
      --profile <name>           Use this profile's db_url
  -h, --help                     Show this help

  Long-running and DB-direct; it prints logs only, so it takes no -o.

DESCRIPTION
  Polls (and LISTENs on the 'fsm_scheduler_work' channel, which nothing
  notifies since SPEC-003) and runs scheduling cycles: SELECT FOR UPDATE SKIP
  LOCKED, filter+score active fsmlets, UPDATE to 'scheduled', pg_notify the
  winning fsmlet. Run on the control plane — NOT on fsmlet nodes.
`;

function positiveInt(flag: string, value: unknown) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw usageError(`${flag} must be a positive integer, got: ${value}`, HELP);
  }
  return n;
}

export async function schedulerCommand(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, {
    string: ["poll-interval", "stale-threshold"],
    alias: { p: "poll-interval", s: "stale-threshold" },
    common: ["db"],
  }, HELP);
  if (args.help) return console.log(HELP);
  verbOf("scheduler", args.positionals, ["run"], HELP);

  const pollIntervalMs = positiveInt(
    "--poll-interval",
    args.flags["poll-interval"],
  );
  const staleThresholdSeconds = positiveInt(
    "--stale-threshold",
    args.flags["stale-threshold"],
  );
  const dbUrl = await resolveDbUrl(args);

  logger.warning(
    "scheduler run is a fallback: pg_cron (`db cron register`) is the primary scheduler (SPEC-003).",
  );

  const controller = new AbortController();
  let shutdownRequested = false;
  const onSignal = () => {
    if (shutdownRequested) {
      logger.info("Force exit.");
      Deno.exit(ExitCode.INTERRUPTED);
    }
    shutdownRequested = true;
    logger.info(
      "Shutdown requested — stopping the scheduler gracefully. Ctrl+C again to force exit...",
    );
    controller.abort();
  };
  Deno.addSignalListener("SIGINT", onSignal);
  Deno.addSignalListener("SIGTERM", onSignal);

  await runFsmScheduler(
    { connectionString: dbUrl, max: 4 },
    { pollIntervalMs, staleThresholdSeconds, signal: controller.signal },
  );
  logger.info("Scheduler stopped.");
}
