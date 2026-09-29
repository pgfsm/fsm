import { getLogger } from "@logtape/logtape";
import { fsmCommand } from "../commands/fsm.ts";
import { instanceCommand } from "../commands/instance.ts";
import { pgcronCommand } from "../commands/pgcron.ts";
import { schedulerCommand } from "../commands/scheduler.ts";
import { CLI_INVOCATION } from "../invocation.ts";
import { configureCtlLogger, CTL_CATEGORY } from "../logger.ts";
import { PACKAGE_VERSION } from "../version.ts";

await configureCtlLogger();
const logger = getLogger([CTL_CATEGORY]);

const HELP = `pgfsmctl ${PACKAGE_VERSION} — operate a pgfsm database

USAGE
  ${CLI_INVOCATION} <noun> <verb> [options]

COMMANDS
  pgcron register | unregister | status
      Manage the fsm_schedule_all_pending pg_cron job (SPEC-003) — the
      primary dispatch scheduler. Run \`register\` once per database, after
      applying migrations.
  fsm load <folder>
      Load <folder>/<fsmName>/<version>/fsm.json definitions into the
      database (SPEC-006) — a deploy step, before starting sync workers.
  instance create | resume | send | stop
      Create an FSM instance, re-enqueue one, send it an event, or stop its
      worker.
  scheduler run
      The standing fsmscheduler process — a fallback only; pg_cron is the
      primary scheduler.

  Run \`${CLI_INVOCATION} <noun> --help\` for a command's options. Every
  command reads the database from -d/--db-url, else DATABASE_URL (a .env in
  the current directory is loaded).

OPTIONS
  -v, --version   Print @pgfsm/ctl's version and exit
  -h, --help      Show this help
`;

const COMMANDS: Record<string, (argv: string[]) => Promise<void>> = {
  pgcron: pgcronCommand,
  fsm: fsmCommand,
  instance: instanceCommand,
  scheduler: schedulerCommand,
};

const [noun, ...rest] = Deno.args;

if (noun === "-v" || noun === "--version") {
  // Bare, undecorated output (no logger prefix) so `$(pgfsmctl --version)`
  // stays script-friendly, matching @pgfsm/compiler's convention (#258).
  console.log(PACKAGE_VERSION);
  Deno.exit(0);
}

if (noun === undefined || noun === "-h" || noun === "--help") {
  console.log(HELP);
  Deno.exit(noun === undefined ? 1 : 0);
}

const command = COMMANDS[noun];
if (!command) {
  logger.error("Unknown command: {noun}", { noun });
  console.log(HELP);
  Deno.exit(1);
}

await command(rest);
