import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";
import { Pool } from "pg";
import { getLogger } from "@logtape/logtape";
import { configureWorkerLogger } from "../logger.ts";
import {
  bootstrapFsmModules,
  startFSMWorkerWithDBLock,
  stopFSMWorker,
} from "../index.ts";
import type { FsmStartupConfig, FsmWorkerEntry } from "../index.ts";
import { createFsmInstanceFromName } from "@pgfsm/db";
import type { Json } from "@pgfsm/db";

const logger = getLogger(["@pgfsm/worker", "ctl"]);
await configureWorkerLogger();

const args = parseArgs(Deno.args, {
  string: ["command", "queue-name", "fsm-name", "fsm-version", "fsm-folder-path", "context", "db-url"],
  boolean: ["help", "validate-plugin"],
  alias: {
    h: "help",
    c: "command",
    q: "queue-name",
    n: "fsm-name",
    v: "fsm-version",
    f: "fsm-folder-path",
    d: "db-url",
  },
});

function printHelp(): void {
  logger.info(`
fsm-worker ctl — FSM control CLI

USAGE
  deno run --allow-all src/cli/ctl.ts -c <command> [options]

COMMANDS
  create   Create a new FSM instance (no worker started; daemon picks it up)
  resume   Resume a worker for an existing FSM instance queue
  stop     Send a stop signal to a running worker via pg_notify

OPTIONS
  -c, --command <command>        Command to run (required)
  -q, --queue-name <id>         FSM instance ID / queue name (required for resume, stop)
  -n, --fsm-name <name>         FSM name (required for create, resume)
  -v, --fsm-version <version>   FSM version (required for create, resume)
  -f, --fsm-folder-path <path>  Absolute path to FSM folder (required for resume)
      --context <json>          Initial FSM context as JSON string (optional, create only)
  -d, --db-url <url>            Database connection URL (overrides DATABASE_URL from .env)
      --validate-plugin         Use plugin validator instead of direct imports (resume only)
  -h, --help                    Show this help message

EXAMPLES
  deno run --allow-all src/cli/ctl.ts -c create -n creditCheck -v 1
  deno run --allow-all src/cli/ctl.ts -c create -n creditCheck -v 1 --context '{"userId":"abc"}'
  deno run --allow-all src/cli/ctl.ts -c resume -q <instance-uuid> -n creditCheck -v 1 -f /abs/path/to/fsm
  deno run --allow-all src/cli/ctl.ts -c stop -q <instance-uuid>
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
const contextArg = args["context"];
const dbUrl = args["db-url"];
const validatePlugin = args["validate-plugin"] === true;

const missing: string[] = [];
if (!command) missing.push("--command");

if (command === "create") {
  if (!fsmName) missing.push("--fsm-name");
  if (!fsmVersion) missing.push("--fsm-version");
}

if (command === "resume") {
  if (!queueName) missing.push("--queue-name");
  if (!fsmName) missing.push("--fsm-name");
  if (!fsmVersion) missing.push("--fsm-version");
  if (!fsmFolderPath) missing.push("--fsm-folder-path");
}

if (command === "stop") {
  if (!queueName) missing.push("--queue-name");
}

if (missing.length > 0) {
  logger.error("Missing required arguments: {missing}", { missing: missing.join(", ") });
  printHelp();
  Deno.exit(1);
}

if (fsmFolderPath) {
  try {
    await Deno.stat(fsmFolderPath);
  } catch {
    logger.error("--fsm-folder-path does not exist: {path}", { path: fsmFolderPath });
    Deno.exit(1);
  }
}

dotenv.config({ path: ".env" });
const resolvedDbUrl = dbUrl ?? Deno.env.get("DATABASE_URL") ?? "";

// ── Graceful shutdown (resume only) ─────────────────────────────────────────

const controller = new AbortController();
let shutdownRequested = false;

const onSignal = () => {
  if (shutdownRequested) {
    logger.info("Force exit.");
    Deno.exit(0);
  }
  shutdownRequested = true;
  logger.info("Shutdown requested — stopping worker gracefully. Ctrl+C again to force exit...");
  controller.abort();
};

Deno.addSignalListener("SIGINT", onSignal);
Deno.addSignalListener("SIGTERM", onSignal);

// ── Commands ─────────────────────────────────────────────────────────────────

try {
  switch (command) {
    case "create": {
      let context: Json = {};
      if (contextArg) {
        try {
          context = JSON.parse(contextArg);
        } catch {
          logger.error("--context is not valid JSON: {context}", { context: contextArg });
          Deno.exit(1);
        }
      }
      const pool = new Pool({ connectionString: resolvedDbUrl });
      const deps = { db: pool, useSupabase: false };
      const result = await createFsmInstanceFromName(deps, fsmName!, fsmVersion!, context, true) as Record<string, Json> | null;
      await pool.end();
      if (!result || !result["fsm_instance_id"]) {
        logger.error("Failed to create FSM instance.");
        Deno.exit(1);
      }
      logger.info(result["fsm_instance_id"]);
      break;
    }

    case "resume": {
      const fsmConfig: FsmStartupConfig = { fsm: { folderPath: fsmFolderPath! } };
      const activeWorkers: Record<string, FsmWorkerEntry> = {};

      const { pool, verifiedFsmModules } = await bootstrapFsmModules(
        { connectionString: resolvedDbUrl },
        fsmConfig,
        {
          onWorkerStop: (queueName) => {
            if (activeWorkers[queueName]) {
              activeWorkers[queueName].lock = false;
              activeWorkers[queueName].controller.abort();
            }
          },
        },
      );

      const deps = { db: pool, useSupabase: false };
      const verifiedModule = verifiedFsmModules.find(
        (m) => m.fsmName === fsmName && m.fsmVersion === String(fsmVersion),
      ) ?? { fsmAbsFolderPath: fsmFolderPath };

      activeWorkers[queueName!] = { lock: true, controller };
      const result = await startFSMWorkerWithDBLock(
        deps,
        queueName!,
        fsmName!,
        Number(fsmVersion),
        verifiedModule,
        validatePlugin,
        controller.signal,
        () => {
          delete activeWorkers[queueName!];
          logger.info("Worker for {queueName} stopped and DB lock released.", { queueName });
        },
      );
      if (result.status === "fail") {
        logger.error("Error: {message}", { message: result.message });
        Deno.exit(1);
      }
      break;
    }

    case "stop": {
      const pool = new Pool({ connectionString: resolvedDbUrl });
      await stopFSMWorker({ db: pool, useSupabase: false }, queueName!);
      logger.info("Stop signal sent for worker queue: {queueName}", { queueName });
      await pool.end();
      break;
    }

    default:
      logger.error("Unknown command: {command}", { command });
      printHelp();
      Deno.exit(1);
  }

  logger.info("Command {command} completed.", { command });
} catch (err) {
  logger.error("Command {command} failed: {error}", { command, error: err });
  Deno.exit(1);
}
