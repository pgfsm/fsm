import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";
import { Pool } from "pg";
import { getLogger } from "@logtape/logtape";
import { configureWorkerLogger } from "../logger.ts";
import { registerScheduleAllPendingCronJob } from "@pgfsm/db";
import { CLI_INVOCATION } from "./pgcron-invocation.ts";
import { PACKAGE_VERSION } from "./version.ts";

const logger = getLogger(["@pgfsm/scheduler", "cli", "pgcron"]);
await configureWorkerLogger();

const args = parseArgs(Deno.args, {
  string: ["db-url", "schedule"],
  boolean: ["help", "version"],
  alias: {
    h: "help",
    v: "version",
    d: "db-url",
    s: "schedule",
  },
});

if (args.version) {
  // Bare, undecorated output (no logger timestamp/category prefix) — see
  // fsmlet.ts's identical --version handling.
  console.log(PACKAGE_VERSION);
  Deno.exit(0);
}

const ALTERNATIVE_TO_FSMSCHEDULER_NOTICE = `
╔══════════════════════════════════════════════════════════════════════════╗
║  NOTE: pgcron is an ALTERNATIVE to the fsmscheduler CLI, not a          ║
║  replacement you must also run. Once this job is registered, pg_cron    ║
║  drives periodic dispatch scheduling on its own — a standing            ║
║  fsmscheduler process is redundant for that purpose (safe to run both,  ║
║  just unnecessary). See spec-003-pgcron-fsm-scheduler.md.               ║
╚══════════════════════════════════════════════════════════════════════════╝
`;

function printHelp(): void {
  logger.info(`
pgcron — one-shot (re)registration of the fsm_schedule_all_pending pg_cron job
${ALTERNATIVE_TO_FSMSCHEDULER_NOTICE}
USAGE
  ${CLI_INVOCATION} [options]

OPTIONS
  -d, --db-url <url>     Database connection URL (overrides DATABASE_URL from .env)
  -s, --schedule <cron>  pg_cron schedule expression (default: "5 seconds")
  -v, --version          Print @pgfsm/sync-worker's version and exit
  -h, --help             Show this help message

DESCRIPTION
  Idempotently (re)registers the 'fsm_schedule_all_pending' pg_cron job,
  which calls fsm_core.schedule_all_pending() on the given schedule to drain
  the fsm dispatch queue — see spec-003-pgcron-fsm-scheduler.md.

  migra's structural diff (used to generate the versioned pgxn migration
  scripts under packages/database-src/supabase/migrations/) only picks up
  DDL — cron.schedule() is a data-level side effect, so it can't be captured
  there. Run this CLI once as a deploy-time step after applying migrations
  (it unschedules any pre-existing job with this name first, so it's safe to
  re-run), or whenever the schedule needs to change.
`);
}

if (args.help) {
  printHelp();
  Deno.exit(0);
}

logger.warning(ALTERNATIVE_TO_FSMSCHEDULER_NOTICE);

dotenv.config({ path: ".env" });
const resolvedDbUrl = args["db-url"] ?? Deno.env.get("DATABASE_URL") ?? "";

if (!resolvedDbUrl) {
  logger.error("DATABASE_URL is required (set in .env or pass --db-url)");
  Deno.exit(1);
}

const schedule = args["schedule"];

const pool = new Pool({ connectionString: resolvedDbUrl, max: 1 });

try {
  await registerScheduleAllPendingCronJob(
    { db: pool, useSupabase: false },
    schedule,
  );
  logger.info("pgcron: job registered.");
} catch (err) {
  logger.error("pgcron: job registration failed: {error}", { error: err });
  Deno.exit(1);
} finally {
  await pool.end();
}
