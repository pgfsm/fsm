import { parseArgs } from "@std/cli/parse-args";
import { getLogger } from "@logtape/logtape";
import {
  getScheduleAllPendingCronJob,
  registerScheduleAllPendingCronJob,
  unregisterScheduleAllPendingCronJob,
} from "@pgfsm/db";
import { CLI_INVOCATION } from "../invocation.ts";
import { CTL_CATEGORY } from "../logger.ts";
import { resolveDbUrl, withPool } from "./db.ts";

const logger = getLogger([CTL_CATEGORY, "pgcron"]);

const HELP = `pgfsmctl pgcron — manage the fsm_schedule_all_pending pg_cron job

USAGE
  ${CLI_INVOCATION} pgcron register [--schedule <cron>] [options]
  ${CLI_INVOCATION} pgcron unregister [options]
  ${CLI_INVOCATION} pgcron status [options]

VERBS
  register     Idempotently (re)register the job (unschedules any existing
               one of the same name first, so it's safe to re-run)
  unregister   Remove the job; succeeds if it isn't registered
  status       Print the registered job, or report that there is none
               (exit code 1 when not registered)

OPTIONS
  -s, --schedule <cron>  pg_cron schedule for register (default: "5 seconds")
  -d, --db-url <url>     Database connection URL (overrides DATABASE_URL from .env)
  -h, --help             Show this help

DESCRIPTION
  The job calls fsm_core.schedule_all_pending() on the given schedule to
  drain the fsm dispatch queue — the primary scheduler (SPEC-003); a
  standing \`pgfsmctl scheduler run\` is only a fallback.

  migra's structural diff (used to generate the versioned migration scripts
  under packages/database-src/supabase/migrations/) only picks up DDL —
  cron.schedule() is a data-level side effect, so it can't be captured
  there. Run \`register\` once as a deploy-time step after applying
  migrations, or whenever the schedule needs to change.
`;

export async function pgcronCommand(argv: string[]): Promise<void> {
  const args = parseArgs(argv, {
    string: ["db-url", "schedule"],
    boolean: ["help"],
    alias: { h: "help", d: "db-url", s: "schedule" },
  });
  const verb = args._[0] === undefined ? undefined : String(args._[0]);

  if (args.help) {
    console.log(HELP);
    Deno.exit(0);
  }
  if (verb !== "register" && verb !== "unregister" && verb !== "status") {
    logger.error(
      verb === undefined
        ? "pgcron needs a verb: register, unregister or status"
        : `Unknown pgcron verb: ${verb}`,
    );
    console.log(HELP);
    Deno.exit(1);
  }

  const dbUrl = resolveDbUrl(args["db-url"]);

  try {
    await withPool(dbUrl, async (deps) => {
      switch (verb) {
        case "register":
          await registerScheduleAllPendingCronJob(deps, args.schedule);
          logger.info("pgcron: job registered.");
          break;
        case "unregister": {
          const removed = await unregisterScheduleAllPendingCronJob(deps);
          logger.info(
            removed
              ? "pgcron: job unregistered."
              : "pgcron: no job was registered.",
          );
          break;
        }
        case "status": {
          const job = await getScheduleAllPendingCronJob(deps);
          if (!job) {
            console.log("fsm_schedule_all_pending: not registered");
            Deno.exit(1);
          }
          console.log(
            `${job.jobname}: registered (jobid ${job.jobid}, schedule "${job.schedule}", ${
              job.active ? "active" : "inactive"
            })\n  command: ${job.command}`,
          );
          break;
        }
      }
    });
  } catch (err) {
    logger.error("pgcron {verb} failed: {error}", { verb, error: err });
    Deno.exit(1);
  }
}
