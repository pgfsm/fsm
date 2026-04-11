import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";

import { startFSMWorker, startFSMWorkerWithDBLock, startFSMPromiseWorker, createAndStartFSMWorker, createAndStartPromiseWorker } from "../index.ts";

const args = parseArgs(Deno.args, {
  string: ["command", "queue-name", "fsm-name", "fsm-version", "fsm-folder-path", "promise-type"],
  boolean: ["help", "validate-plugin"],
  alias: {
    h: "help",
    c: "command",
    q: "queue-name",
    n: "fsm-name",
    v: "fsm-version",
    f: "fsm-folder-path",
    t: "promise-type",
  },
});

function printHelp(): void {
  console.log(`
fsm-worker — FSM worker CLI

USAGE
  deno run --allow-all src/cli/index.ts -c <command> [options]

COMMANDS
  start-worker                      Start FSM queue worker (requires -q)
  start-worker-with-db-lock         Start FSM worker with DB advisory lock (requires -q)
  start-promise-worker              Start FSM promise worker for existing queue (requires -q, -t)
  create-and-start-worker           Create FSM instance + queue and start worker with DB lock
  create-and-start-promise-worker   Create PGMQ queue and start promise worker (requires -q, -t)

OPTIONS
  -c, --command <command>           Command to run (required)
  -q, --queue-name <queueName>      Queue name (required for start-worker, start-worker-with-db-lock, start-promise-worker, create-and-start-promise-worker)
  -n, --fsm-name <name>             FSM name (required)
  -v, --fsm-version <version>       FSM version number (required)
  -f, --fsm-folder-path <path>      Absolute path to FSM folder for loading actions/guards/delays/actors (required)
  -t, --promise-type <type>         Promise actor type to invoke (required for start-promise-worker, create-and-start-promise-worker)
      --validate-plugin             Use validateFsmPluginLoadFromFolder instead of direct imports
  -h, --help                        Show this help message

EXAMPLES
  deno run --allow-all src/cli/index.ts -c start-worker -q creditCheck_v01 -n creditCheck -v 1 -f /abs/path/to/fsm
  deno run --allow-all src/cli/index.ts -c start-worker-with-db-lock -q creditCheck_v01 -n creditCheck -v 1 -f /abs/path/to/fsm --validate-plugin
  deno run --allow-all src/cli/index.ts -c start-promise-worker -q checkBureau_v01 -n checkBureau -v 1 -t checkBureau -f /abs/path/to/fsm
  deno run --allow-all src/cli/index.ts -c create-and-start-worker -n creditCheck -v 1 -f /abs/path/to/fsm --validate-plugin
  deno run --allow-all src/cli/index.ts -c create-and-start-promise-worker -q checkBureau_v01 -n checkBureau -v 1 -t checkBureau -f /abs/path/to/fsm
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
const promiseType = args["promise-type"];

const needsQueueName = ["start-worker", "start-worker-with-db-lock", "start-promise-worker", "create-and-start-promise-worker"];
const needsPromiseType = ["start-promise-worker", "create-and-start-promise-worker"];

const missing: string[] = [];
if (!command) missing.push("--command");
if (command && needsQueueName.includes(command) && !queueName) missing.push("--queue-name");
if (command && needsPromiseType.includes(command) && !promiseType) missing.push("--promise-type");
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
  return { db: new Pool({ connectionString: Deno.env.get("DATABASE_URL") }), useSupabase: false };
}

const verifiedModule = { fsmAbsFolderPath: fsmFolderPath };
const validatePlugin = args["validate-plugin"] === true;

try {
  switch (command) {
    case "start-worker": {
      const deps = await buildDeps();
      await startFSMWorker(deps, queueName!, fsmName!, Number(fsmVersion), verifiedModule, validatePlugin);
      break;
    }
    case "start-worker-with-db-lock": {
      const deps = await buildDeps();
      const activeLocks: Record<string, boolean> = {};
      const acquired = await startFSMWorkerWithDBLock(deps, queueName!, fsmName!, Number(fsmVersion), activeLocks, verifiedModule, validatePlugin);
      if (!acquired) {
        console.error(`Error: Could not acquire DB lock for queue "${queueName}" — another worker may already hold it.`);
        Deno.exit(1);
      }
      await new Promise(() => {});
      break;
    }
    case "start-promise-worker": {
      const deps = await buildDeps();
      startFSMPromiseWorker(deps, queueName!, promiseType!, fsmName!, fsmVersion!, verifiedModule).catch((err) => {
        console.error(`Promise worker for queue "${queueName}" stopped:`, err);
        Deno.exit(1);
      });
      console.log(`Promise worker started for queue: ${queueName}`);
      await new Promise(() => {});
      break;
    }
    case "create-and-start-promise-worker": {
      const deps = await buildDeps();
      await createAndStartPromiseWorker(deps, queueName!, fsmName!, promiseType!, fsmVersion!, verifiedModule);
      console.log(`Promise worker started for queue: ${queueName}`);
      await new Promise(() => {});
      break;
    }
    case "create-and-start-worker": {
      const deps = await buildDeps();
      const activeLocks: Record<string, boolean> = {};
      const fsm_instance = await createAndStartFSMWorker(deps, fsmName!, fsmVersion!, verifiedModule, activeLocks, validatePlugin);
      if (!fsm_instance) {
        console.error(`Error: Failed to create FSM instance for "${fsmName}" v${fsmVersion}.`);
        Deno.exit(1);
      }
      console.log(`FSM instance created: ${fsm_instance.fsm_instance_id}`);
      await new Promise(() => {});
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
