import { getLogger } from "@logtape/logtape";
import { parseCommandArgs } from "../args.ts";
import { completionCommand } from "../commands/completion.ts";
import { configCommand } from "../commands/config.ts";
import { dbCommand } from "../commands/db.ts";
import { fsmCommand } from "../commands/fsm.ts";
import { instanceCommand } from "../commands/instance.ts";
import { keyCommand } from "../commands/key.ts";
import { schedulerCommand } from "../commands/scheduler.ts";
import { COMMAND_TREE } from "../commands/tree.ts";
import { CtlError, ExitCode, exitCodeFor, usageError } from "../exit.ts";
import { CLI_INVOCATION } from "../invocation.ts";
import { configureCtlLogger, CTL_CATEGORY } from "../logger.ts";
import { printRecord } from "../output.ts";
import { PACKAGE_VERSION } from "../version.ts";

await configureCtlLogger();
const logger = getLogger([CTL_CATEGORY]);

// [usage, noun (for its tier), description]
const COMMAND_LINES: [string, string, string][] = [
  [
    "db cron register | unregister | status",
    "db",
    "The fsm_schedule_all_pending pg_cron job (SPEC-003), the primary\ndispatch scheduler. A deploy step: run `register` after migrations.",
  ],
  [
    "db key create --name <n> --role <r>",
    "db",
    "Mint an API key straight in the database: the bootstrap admin key.",
  ],
  [
    "fsm load <folder>",
    "fsm",
    "Load <folder>/<fsmName>/<version>/fsm.json definitions (SPEC-006), a\ndeploy step before starting sync workers. API if one is configured.",
  ],
  [
    "instance create | resume | send | stop",
    "instance",
    "Create an FSM instance, re-enqueue one, send it an event, or stop its\nworker.",
  ],
  [
    "key create | list | revoke",
    "key",
    "API keys, through the API (admin key, --enable-admin-api).",
  ],
  [
    "scheduler run",
    "scheduler",
    "The standing fsmscheduler process: a fallback only; pg_cron is the\nprimary scheduler.",
  ],
  [
    "config set | use | list | show",
    "config",
    "Named targets (profiles): database and API URLs, secrets kept apart.",
  ],
  [
    "completion bash | zsh | fish",
    "completion",
    "Print a shell completion script.",
  ],
  ["version", "version", "Print @pgfsm/ctl's version."],
];

const COMMANDS_HELP = COMMAND_LINES.map(([usage, noun, text]) =>
  `  ${usage.padEnd(42)} [${COMMAND_TREE[noun].tier}]\n` +
  text.split("\n").map((l) => `      ${l}`).join("\n")
).join("\n");

const HELP = `pgfsmctl ${PACKAGE_VERSION} — operate a pgfsm deployment

USAGE
  ${CLI_INVOCATION} <noun> <verb> [options]

COMMANDS
${COMMANDS_HELP}

  Run \`${CLI_INVOCATION} <noun> --help\` for a command's options.

TARGETS
  Database: --db-url, else --profile / PGFSM_PROFILE, else PGFSM_DB_URL or
  DATABASE_URL (./.env is read), else the current profile (\`config use\`).
  API: --url + --api-key, else the explicit profile's url/api_key, else
  PGFSM_URL + PGFSM_API_KEY, else the current profile's. The URL includes the
  API's path prefix, e.g. http://localhost:9999/fsm.

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
  key: keyCommand,
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
