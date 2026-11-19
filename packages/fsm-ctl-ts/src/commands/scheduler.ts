import { getLogger } from "@logtape/logtape";
import { apiRequest } from "../api-client.ts";
import { requireApiTarget } from "../api-target.ts";
import { parseCommandArgs, verbOf } from "../args.ts";
import { CtlError, ExitCode, usageError } from "../exit.ts";
import { CLI_INVOCATION } from "../invocation.ts";
import { CTL_CATEGORY } from "../logger.ts";
import { printRecord } from "../output.ts";

const logger = getLogger([CTL_CATEGORY, "scheduler"]);

const HELP =
  `pgfsmctl scheduler — the scheduler's pg_cron job, through the API (SPEC-016)

USAGE
  ${CLI_INVOCATION} scheduler status [options]
  ${CLI_INVOCATION} scheduler register [--schedule <schedule>] [options]

  The fsm_schedule_all_pending pg_cron job drains the dispatch queue
  (SPEC-003). Installing fsm_core registers it; these check it, and
  re-register it (e.g. after \`cron.unschedule\`) or change its schedule.

VERBS
  status     The job: registered or not, its schedule, command and whether
             it's active. Exit 5 when it isn't registered.
  register   (Re)register it, replacing any existing one (idempotent).

OPTIONS
      --schedule <s>      register: pg_cron schedule, e.g. '10 seconds' or
                          '*/1 * * * *' (default: 5 seconds)
      --url <url>         API base URL incl. its path prefix, e.g. http://localhost:9999/api/v1
      --api-key <key>     Admin key (GET/POST /admin/scheduler, --enable-admin-api)
      --profile <name>    Use this profile's url and api_key
  -o, --output <fmt>      table (default), json or ids (the job name)
  -h, --help              Show this help
`;

type SchedulerJob = {
  jobname: string;
  registered: boolean;
  jobid?: number;
  schedule?: string;
  command?: string;
  active?: boolean;
};

export async function schedulerCommand(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, {
    string: ["schedule"],
    common: ["api", "output"],
  }, HELP);
  if (args.help) return console.log(HELP);
  const verb = verbOf(
    "scheduler",
    args.positionals,
    ["status", "register"],
    HELP,
  );
  const schedule = args.flags.schedule as string | undefined;
  if (verb === "status" && schedule !== undefined) {
    throw usageError("--schedule is for scheduler register", HELP);
  }
  if (schedule === "") throw usageError("--schedule is empty", HELP);

  const api = await requireApiTarget(args, `scheduler ${verb}`);
  const { data } = verb === "status"
    ? await apiRequest<{ data: SchedulerJob }>(api, "GET", "/admin/scheduler")
    : await apiRequest<{ data: SchedulerJob }>(
      api,
      "POST",
      "/admin/scheduler",
      schedule === undefined ? {} : { schedule },
    );
  if (verb === "register") {
    logger.info(`Registered ${data.jobname}: ${data.schedule}`);
  }
  printRecord(
    {
      jobname: data.jobname,
      registered: data.registered,
      schedule: data.schedule ?? null,
      active: data.active ?? null,
      command: data.command ?? null,
    },
    args.output,
    { id: (r) => r.jobname },
  );
  if (!data.registered) {
    throw new CtlError(
      ExitCode.CHECK_FAILED,
      `The ${data.jobname} pg_cron job isn't registered: run \`${CLI_INVOCATION} scheduler register\`.`,
    );
  }
}
