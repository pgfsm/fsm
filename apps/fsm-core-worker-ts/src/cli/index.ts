import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";

import { startFSMWorker, startFSMWorkerWithDBLock, startFSMPromiseWorker } from "../index.ts";

const args = parseArgs(Deno.args, {
  string: ["command", "queue-name", "fsm-name", "fsm-version", "fsm-folder-path"],
  boolean: ["help"],
  alias: {
    h: "help",
    c: "command",
    q: "queue-name",
    n: "fsm-name",
    v: "fsm-version",
    f: "fsm-folder-path",
  },
});

function printHelp(): void {
  console.log(`
fsm-worker — FSM worker CLI

USAGE
  deno run --allow-all src/cli/index.ts -c <command> -q <queueName> -n <name> -v <version> -f <path>

COMMANDS
  start-worker              Start FSM queue worker
  start-worker-with-db-lock Start FSM worker with DB advisory lock
  start-promise-worker      Start FSM promise worker

OPTIONS
  -c, --command <command>         Command to run (required)
  -q, --queue-name <queueName>    Queue name (required)
  -n, --fsm-name <name>           FSM name (required)
  -v, --fsm-version <version>     FSM version number (required)
  -f, --fsm-folder-path <path>    Absolute path to FSM folder for loading actions/guards/delays/actors (required)
  -h, --help                      Show this help message

EXAMPLES
  deno run --allow-all src/cli/index.ts -c start-worker -q creditCheck_v01 -n creditCheck -v 1 -f /abs/path/to/fsm
  deno run --allow-all src/cli/index.ts -c start-worker-with-db-lock -q creditCheck_v01 -n creditCheck -v 1 -f /abs/path/to/fsm
  deno run --allow-all src/cli/index.ts -c start-promise-worker -q sharedPromise_v01 -n sharedPromise -v 1 -f /abs/path/to/fsm
`);
}

if (args.help) {
  printHelp();
  Deno.exit(0);
}

const command = args["command"];
const queueName = args["queue-name"];
const fsmName = args["fsm-name"];
const fsmVersion = args["fsm-version"];
const fsmFolderPath = args["fsm-folder-path"];

const missing: string[] = [];
if (!command) missing.push("--command");
if (!queueName) missing.push("--queue-name");
if (!fsmName) missing.push("--fsm-name");
if (!fsmVersion) missing.push("--fsm-version");
if (!fsmFolderPath) missing.push("--fsm-folder-path");

if (missing.length > 0) {
  console.error(`Error: Missing required arguments: ${missing.join(", ")}\n`);
  printHelp();
  Deno.exit(1);
}

async function buildDeps() {
  dotenv.config({ path: ".env" });
  const { Pool } = await import("pg");
  return { db: new Pool({ connectionString: Deno.env.get("DATABASE_URL") }) };
}

const verifiedModule = { fsmAbsFolderPath: fsmFolderPath };

try {
  switch (command) {
    case "start-worker": {
      const deps = await buildDeps();
      await startFSMWorker(deps, queueName!, fsmName!, Number(fsmVersion), verifiedModule);
      break;
    }
    case "start-worker-with-db-lock": {
      const deps = await buildDeps();
      const activeLocks: Record<string, boolean> = {};
      const acquired = await startFSMWorkerWithDBLock(deps, queueName!, fsmName!, Number(fsmVersion), activeLocks, verifiedModule);
      if (!acquired) {
        console.error(`Error: Could not acquire DB lock for queue "${queueName}" — another worker may already hold it.`);
        Deno.exit(1);
      }
      await new Promise(() => {});
      break;
    }
    case "start-promise-worker": {
      const deps = await buildDeps();
      await startFSMPromiseWorker(deps, queueName!, fsmName!, Number(fsmVersion));
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
