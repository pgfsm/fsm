import { getLogger } from "@logtape/logtape";
import {
  createApiKey,
  getScheduleAllPendingCronJob,
  registerScheduleAllPendingCronJob,
  unregisterScheduleAllPendingCronJob,
} from "@pgfsm/db";
import { parseCommandArgs, verbOf } from "../args.ts";
import { resolveDbUrl, withPool } from "../db-target.ts";
import { CtlError, ExitCode, usageError } from "../exit.ts";
import { CLI_INVOCATION } from "../invocation.ts";
import { KEY_ONCE_WARNING, parseKeyRole } from "../key-role.ts";
import { CTL_CATEGORY } from "../logger.ts";
import { printRecord } from "../output.ts";

const logger = getLogger([CTL_CATEGORY, "db"]);

const JOB_NAME = "fsm_schedule_all_pending";

const HELP = `pgfsmctl db — database setup, always DB-direct (SPEC-009 §4)

USAGE
  ${CLI_INVOCATION} db cron register [--schedule <cron>] [options]
  ${CLI_INVOCATION} db cron unregister [options]
  ${CLI_INVOCATION} db cron status [options]
  ${CLI_INVOCATION} db key create --name <name> --role admin|operator [options]

  Every \`db\` command talks to Postgres directly, never to the REST API:
  these are deploy steps (run from CI or a Kubernetes Job as the schema
  owner), so they must work before the API is up. \`db migrate\` is reserved.

VERBS (db key)
  create       Create an API key straight in the database, as the schema
               owner: the way to mint the first admin key, before any key can
               call the API (SPEC-009 §2). Prints the key once. After that,
               manage keys over the API: \`${CLI_INVOCATION} key …\`.

VERBS (db cron)
  register     Idempotently (re)register the fsm_schedule_all_pending pg_cron
               job (unschedules any existing one of the same name first)
  unregister   Remove the job; succeeds if it isn't registered
  status       Print the registered job; exits 5 when it isn't registered

OPTIONS
  -s, --schedule <cron>  pg_cron schedule for register (default: "5 seconds")
      --name <name>      Key name (db key create; unique)
      --role <role>      admin or operator (db key create)
  -d, --db-url <url>     Postgres URL (else --profile, PGFSM_DB_URL, DATABASE_URL, current profile)
      --profile <name>   Use this profile's db_url
  -o, --output <fmt>     table (default), json or ids
  -h, --help             Show this help

DESCRIPTION
  The job calls fsm_core.schedule_all_pending() to drain the fsm dispatch
  queue: the primary scheduler (SPEC-003); a standing
  \`${CLI_INVOCATION} scheduler run\` is only a fallback. cron.schedule() is a
  data-level call, so \`supabase db diff\` can't put it in a migration: run
  \`register\` once after applying migrations, or when the schedule changes.
`;

export async function dbCommand(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, {
    string: ["schedule", "name", "role"],
    alias: { s: "schedule" },
    common: ["db", "output"],
  }, HELP);
  if (args.help) return console.log(HELP);

  const sub = verbOf("db", args.positionals, ["cron", "key", "migrate"], HELP);
  if (sub === "migrate") {
    throw usageError("db migrate is reserved and not implemented yet", HELP);
  }
  if (sub === "key") return dbKey(args.positionals.slice(1), args);
  const verb = verbOf(
    "db cron",
    args.positionals.slice(1),
    ["register", "unregister", "status"],
    HELP,
  );
  const dbUrl = await resolveDbUrl(args);

  await withPool(dbUrl, async (deps) => {
    switch (verb) {
      case "register": {
        const schedule = args.flags.schedule as string | undefined;
        await registerScheduleAllPendingCronJob(deps, schedule);
        const job = await getScheduleAllPendingCronJob(deps);
        logger.info("db cron: job registered.");
        printRecord(
          { jobname: JOB_NAME, registered: true, schedule: job?.schedule },
          args.output,
          { id: (r) => r.jobname },
        );
        break;
      }
      case "unregister": {
        const removed = await unregisterScheduleAllPendingCronJob(deps);
        logger.info(
          removed
            ? "db cron: job unregistered."
            : "db cron: no job was registered.",
        );
        printRecord({ jobname: JOB_NAME, removed }, args.output, {
          id: (r) => r.jobname,
        });
        break;
      }
      case "status": {
        const job = await getScheduleAllPendingCronJob(deps);
        if (!job) {
          printRecord(
            { jobname: JOB_NAME, registered: false },
            args.output,
            { id: (r) => r.jobname },
          );
          throw new CtlError(
            ExitCode.CHECK_FAILED,
            `${JOB_NAME} is not registered (${CLI_INVOCATION} db cron register)`,
          );
        }
        printRecord({ ...job, registered: true }, args.output, {
          id: (r) => r.jobname,
        });
        break;
      }
    }
  });
}

async function dbKey(
  positionals: string[],
  args: Awaited<ReturnType<typeof parseCommandArgs>>,
): Promise<void> {
  verbOf("db key", positionals, ["create"], HELP);
  const name = args.flags.name;
  if (typeof name !== "string" || name === "") {
    throw usageError("db key create needs --name", HELP);
  }
  const role = parseKeyRole(args.flags.role, HELP);
  const dbUrl = await resolveDbUrl(args);
  const created = await withPool(
    dbUrl,
    (deps) => createApiKey(deps, name, role),
  );
  logger.warning(KEY_ONCE_WARNING);
  printRecord(created, args.output, { id: (r) => r.id });
}
