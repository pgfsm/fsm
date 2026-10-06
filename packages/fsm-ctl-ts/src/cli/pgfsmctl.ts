import { getLogger } from "@logtape/logtape";
import { parseCommandArgs } from "../args.ts";
import { completionCommand } from "../commands/completion.ts";
import { configCommand } from "../commands/config.ts";
import { dbCommand } from "../commands/db.ts";
import { fsmCommand } from "../commands/fsm.ts";
import { instanceCommand } from "../commands/instance.ts";
import { schedulerCommand } from "../commands/scheduler.ts";
import { COMMAND_TREE } from "../commands/tree.ts";
import { CtlError, ExitCode, exitCodeFor, usageError } from "../exit.ts";
import { CLI_INVOCATION } from "../invocation.ts";
import { configureCtlLogger, CTL_CATEGORY } from "../logger.ts";
import { printRecord } from "../output.ts";
import { PACKAGE_VERSION } from "../version.ts";

await configureCtlLogger();
const logger = getLogger([CTL_CATEGORY]);

const tier = (noun: string) => `[${COMMAND_TREE[noun].tier}]`;

const HELP = `pgfsmctl ${PACKAGE_VERSION} — operate a pgfsm deployment

USAGE
  ${CLI_INVOCATION} <noun> <verb> [options]

COMMANDS
  db cron register | unregister | status                     ${tier("db")}
      The fsm_schedule_all_pending pg_cron job (SPEC-003), the primary
      dispatch scheduler. A deploy step: run \`register\` after migrations.
  fsm load <folder>                                           ${tier("fsm")}
      Load <folder>/<fsmName>/<version>/fsm.json definitions (SPEC-006), a
      deploy step before starting sync workers.
  instance create | resume | send | stop                      ${
  tier("instance")
}
      Create an FSM instance, re-enqueue one, send it an event, or stop its
      worker.
  scheduler run                                               ${
  tier("scheduler")
}
      The standing fsmscheduler process: a fallback only; pg_cron is the
      primary scheduler.
  config set | use | list | show                              ${tier("config")}
      Named targets (profiles): database and API URLs, secrets kept apart.
  completion bash | zsh | fish                                ${
  tier("completion")
}
      Print a shell completion script.
  version                                                     ${tier("version")}
      Print @pgfsm/ctl's version.

  Run \`${CLI_INVOCATION} <noun> --help\` for a command's options.

TARGET (DB-direct commands)
  --db-url, else --profile / PGFSM_PROFILE, else PGFSM_DB_URL or DATABASE_URL
  (./.env is read), else the current profile (\`config use\`).

OUTPUT
  -o table (default) | json | ids. Data goes to stdout, logs to stderr.

EXIT CODES
  0 ok · 1 error · 2 usage · 3 auth · 4 not found · 5 check failed · 130 interrupted

OPTIONS
  -v, --version   Print @pgfsm/ctl's version and exit
  -h, --help      Show this help
`;

const VERSION_HELP = `pgfsmctl version — print @pgfsm/ctl's version (local)

USAGE
  ${CLI_INVOCATION} version [-o table|json|ids]
`;

function versionCommand(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, { common: ["output"] }, VERSION_HELP);
  if (args.help) console.log(VERSION_HELP);
  else if (args.output === "table") console.log(PACKAGE_VERSION);
  else {
    printRecord({ version: PACKAGE_VERSION }, args.output, {
      id: (r) => r.version,
    });
  }
  return Promise.resolve();
}

const COMMANDS: Record<string, (argv: string[]) => Promise<void>> = {
  db: dbCommand,
  fsm: fsmCommand,
  instance: instanceCommand,
  scheduler: schedulerCommand,
  config: configCommand,
  completion: completionCommand,
  version: versionCommand,
};

const [noun, ...rest] = Deno.args;

if (noun === "-v" || noun === "--version") {
  // Bare, undecorated output (no logger prefix) so `$(pgfsmctl --version)`
  // stays script-friendly, matching @pgfsm/compiler's convention (#258).
  console.log(PACKAGE_VERSION);
  Deno.exit(ExitCode.OK);
}
if (noun === "-h" || noun === "--help") {
  console.log(HELP);
  Deno.exit(ExitCode.OK);
}

// `scheduler run` handles Ctrl-C itself (graceful stop, then force-exit 130).
if (noun !== "scheduler") {
  Deno.addSignalListener("SIGINT", () => Deno.exit(ExitCode.INTERRUPTED));
}

try {
  if (noun === undefined) throw usageError("Missing command.", HELP);
  const command = COMMANDS[noun];
  if (!command) throw usageError(`Unknown command: ${noun}`, HELP);
  await command(rest);
} catch (err) {
  const code = exitCodeFor(err);
  if (err instanceof CtlError) {
    logger.error(err.message);
    // Help on a usage error goes to stderr: stdout is data.
    if (err.hint) console.error(err.hint);
  } else {
    logger.error("{error}", { error: err });
  }
  Deno.exit(code);
}
