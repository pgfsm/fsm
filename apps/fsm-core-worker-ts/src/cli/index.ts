import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";

import { startFSMWorker, startFSMPromiseWorker } from "../index.ts";

const args = parseArgs(Deno.args, {
  string: ["fsm-name", "fsm-version"],
  boolean: ["help"],
  alias: { h: "help", n: "fsm-name", v: "fsm-version" },
});

const [command, queueName] = args._ as string[];

function printHelp(): void {
  console.log(`
fsm-worker — FSM worker CLI

USAGE
  deno run --allow-all src/cli/index.ts <command> <queueName> [options]

COMMANDS
  start-worker <queueName> -n <name> -v <version>          Start FSM queue worker
  start-promise-worker <queueName> -n <name> -v <version>  Start FSM promise worker

OPTIONS
  -n, --fsm-name <name>        FSM name (required)
  -v, --fsm-version <version>  FSM version number (required)
  -h, --help                   Show this help message

EXAMPLES
  deno run --allow-all src/cli/index.ts start-worker creditCheck_v01 -n creditCheck -v 1
  deno run --allow-all src/cli/index.ts start-promise-worker sharedPromise_v01 -n sharedPromise -v 1
`);
}

if (args.help || !command) {
  printHelp();
  Deno.exit(0);
}

if (!queueName) {
  console.error(`Error: <queueName> argument is required for command "${command}"\n`);
  printHelp();
  Deno.exit(1);
}

const fsmName = args["fsm-name"];
const fsmVersion = args["fsm-version"];

if (!fsmName) {
  console.error(`Error: --fsm-name is required for command "${command}"\n`);
  printHelp();
  Deno.exit(1);
}

if (!fsmVersion) {
  console.error(`Error: --fsm-version is required for command "${command}"\n`);
  printHelp();
  Deno.exit(1);
}

async function buildDeps() {
  dotenv.config({ path: ".env" });
  const { Pool } = await import("pg");
  return { db: new Pool({ connectionString: Deno.env.get("DATABASE_URL") }) };
}

try {
  switch (command) {
    case "start-worker": {
      const deps = await buildDeps();
      await startFSMWorker(deps, queueName, fsmName, Number(fsmVersion));
      break;
    }
    case "start-promise-worker": {
      const deps = await buildDeps();
      await startFSMPromiseWorker(deps, queueName, fsmName, Number(fsmVersion));
      break;
    }
    default:
      console.error(`Error: Unknown command "${command}"\n`);
      printHelp();
      Deno.exit(1);
  }

  console.log(`\nCommand "${command}" completed.`);
} catch (err) {
  console.error(`\nCommand "${command}" failed:`, err);
  Deno.exit(1);
}
