import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";

import { configureWorkerLogger } from "../logger.ts";
import {
  startFSMWorkerWithDBLock,
  startFSMPromiseWorker,
  createAndStartFSMWorker,
  createAndStartPromiseWorker,
  stopFSMWorker,
  bootstrapFsmModules,
} from "../index.ts";
import type { FsmStartupConfig, FsmWorkerEntry } from "../index.ts";

const args = parseArgs(Deno.args, {
  string: ["command", "queue-name", "fsm-name", "fsm-version", "fsm-folder-path", "promise-type", "db-url"],
  boolean: ["help", "validate-plugin"],
  alias: {
    h: "help",
    c: "command",
    q: "queue-name",
    n: "fsm-name",
    v: "fsm-version",
    f: "fsm-folder-path",
    t: "promise-type",
    d: "db-url",
  },
});

function printHelp(): void {
  console.log(`
fsm-worker — FSM worker CLI

USAGE
  deno run --allow-all src/cli/index.ts -c <command> [options]

COMMANDS
  resume-worker                     Resume FSM worker with DB advisory lock on an existing queue (requires -q)
  start-promise-worker              Start FSM promise worker for existing queue (requires -q, -t)
  create-and-start-worker           Create FSM instance + queue and start worker with DB lock
  create-and-start-promise-worker   Create PGMQ queue and start promise worker (requires -q, -t)
  stop-worker                       Send stop signal to a running worker via pg_notify (requires -q)

OPTIONS
  -c, --command <command>           Command to run (required)
  -q, --queue-name <queueName>      Queue name (required for most commands)
  -n, --fsm-name <name>             FSM name (required except for stop-worker)
  -v, --fsm-version <version>       FSM version number (required except for stop-worker)
  -f, --fsm-folder-path <path>      Absolute path to FSM folder for loading actions/guards/delays/actors (required except for stop-worker)
  -t, --promise-type <type>         Promise actor type to invoke (required for start-promise-worker, create-and-start-promise-worker)
  -d, --db-url <url>                Database connection URL (overrides DATABASE_URL from .env)
      --validate-plugin             Use validateFsmPluginLoadFromFolder instead of direct imports
  -h, --help                        Show this help message

EXAMPLES
  deno run --allow-all src/cli/index.ts -c resume-worker -q creditCheck_v01 -n creditCheck -v 1 -f /abs/path/to/fsm --validate-plugin
  deno run --allow-all src/cli/index.ts -c start-promise-worker -q checkBureau_v01 -n checkBureau -v 1 -t checkBureau -f /abs/path/to/fsm
  deno run --allow-all src/cli/index.ts -c create-and-start-worker -n creditCheck -v 1 -f /abs/path/to/fsm --validate-plugin
  deno run --allow-all src/cli/index.ts -c create-and-start-promise-worker -q checkBureau_v01 -n checkBureau -v 1 -t checkBureau -f /abs/path/to/fsm
  deno run --allow-all src/cli/index.ts -c stop-worker -q <instance-uuid>
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
const dbUrl = args["db-url"];

const needsQueueName = ["resume-worker", "start-promise-worker", "create-and-start-promise-worker", "stop-worker"];
const needsPromiseType = ["start-promise-worker", "create-and-start-promise-worker"];
const needsFsmDetails = ["resume-worker", "start-promise-worker", "create-and-start-promise-worker", "create-and-start-worker"];

const missing: string[] = [];
if (!command) missing.push("--command");
if (command && needsQueueName.includes(command) && !queueName) missing.push("--queue-name");
if (command && needsPromiseType.includes(command) && !promiseType) missing.push("--promise-type");
if (command && needsFsmDetails.includes(command)) {
  if (!fsmName) missing.push("--fsm-name");
  if (!fsmVersion) missing.push("--fsm-version");
  if (!fsmFolderPath) missing.push("--fsm-folder-path");
}

if (missing.length > 0) {
  console.error(`Error: Missing required arguments: ${missing.join(", ")}\n`);
  printHelp();
  Deno.exit(1);
}

if (fsmFolderPath) {
  try {
    await Deno.stat(fsmFolderPath);
  } catch {
    console.error(`Error: --fsm-folder-path "${fsmFolderPath}" does not exist.`);
    Deno.exit(1);
  }
}

const validatePlugin = args["validate-plugin"] === true;

// ── Graceful / force shutdown ────────────────────────────────────────────────

const controller = new AbortController();
let shutdownRequested = false;

const onSignal = () => {
  if (shutdownRequested) {
    console.log("\nForce exit.");
    Deno.exit(0);
  }
  shutdownRequested = true;
  console.log("\nShutdown requested — stopping worker gracefully. Ctrl+C again to force exit...");
  controller.abort();
};

Deno.addSignalListener("SIGINT", onSignal);
Deno.addSignalListener("SIGTERM", onSignal);

// Resolves once the abort signal fires (used to block fire-and-forget commands).
const waitForAbort = () =>
  new Promise<void>((resolve) =>
    controller.signal.addEventListener("abort", () => resolve(), { once: true })
  );

// ── Bootstrap ────────────────────────────────────────────────────────────────

dotenv.config({ path: ".env" });
await configureWorkerLogger();
const resolvedDbUrl = dbUrl ?? Deno.env.get("DATABASE_URL") ?? "";

// activeWorkers tracks running workers so pgListenerForWorkerStopEvent can stop them
const activeWorkers: Record<string, FsmWorkerEntry> = {};

// Bootstrap is skipped for stop-worker — it only needs a bare DB connection
let pool: Awaited<ReturnType<typeof bootstrapFsmModules>>["pool"] | undefined;
let verifiedFsmModules: Awaited<ReturnType<typeof bootstrapFsmModules>>["verifiedFsmModules"] = [];

if (command && needsFsmDetails.includes(command)) {
  const fsmConfig: FsmStartupConfig = { fsm: { folderPath: fsmFolderPath! } };
  const result = await bootstrapFsmModules({ connectionString: resolvedDbUrl }, fsmConfig, {
    onWorkerStop: (queueName) => {
      if (activeWorkers[queueName]) {
        activeWorkers[queueName].lock = false;
        activeWorkers[queueName].controller.abort();
      }
    },
  });
  pool = result.pool;
  verifiedFsmModules = result.verifiedFsmModules;
}

const deps = { db: pool!, useSupabase: false };
const verifiedModule = verifiedFsmModules.find(
  (m) => m.fsmName === fsmName && m.fsmVersion === String(fsmVersion),
) ?? { fsmAbsFolderPath: fsmFolderPath };

// ── Commands ─────────────────────────────────────────────────────────────────

try {
  switch (command) {
    case "resume-worker": {
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
          console.log(`Worker for "${queueName}" stopped and DB lock released.`);
        },
      );
      if (result.status === "fail") {
        console.error(`Error: ${result.message}`);
        Deno.exit(1);
      }
      break;
    }
    case "start-promise-worker": {
      activeWorkers[queueName!] = { lock: true, controller };
      startFSMPromiseWorker(deps, queueName!, promiseType!, fsmName!, fsmVersion!, verifiedModule, controller.signal).catch((err) => {
        console.error(`Promise worker for queue "${queueName}" stopped:`, err);
        Deno.exit(1);
      });
      console.log(`Promise worker started for queue: ${queueName}. Press Ctrl+C to stop.`);
      await waitForAbort();
      break;
    }
    case "create-and-start-promise-worker": {
      activeWorkers[queueName!] = { lock: true, controller };
      await createAndStartPromiseWorker(deps, queueName!, fsmName!, promiseType!, fsmVersion!, verifiedModule, controller.signal);
      console.log(`Promise worker started for queue: ${queueName}. Press Ctrl+C to stop.`);
      await waitForAbort();
      break;
    }
    case "create-and-start-worker": {
      let createdInstanceId: string | undefined;
      const { fsm_instance, workerResult } = await createAndStartFSMWorker(
        deps,
        fsmName!,
        fsmVersion!,
        verifiedModule,
        {},
        validatePlugin,
        controller.signal,
        () => {
          if (createdInstanceId) delete activeWorkers[createdInstanceId];
          console.log(`Worker for "${createdInstanceId}" stopped and DB lock released.`);
        },
      );
      if (!fsm_instance) {
        console.error(`Error: Failed to create FSM instance for "${fsmName}" v${fsmVersion}.`);
        Deno.exit(1);
      }
      createdInstanceId = fsm_instance.fsm_instance_id;
      activeWorkers[createdInstanceId] = { lock: true, controller };
      console.log(`FSM instance created: ${createdInstanceId}.`);
      if (workerResult?.status === "fail") {
        console.error(`Error: ${workerResult.message}`);
        Deno.exit(1);
      }
      break;
    }
    case "stop-worker": {
      const { Pool } = await import("pg");
      const stopPool = new Pool({ connectionString: resolvedDbUrl });
      await stopFSMWorker({ db: stopPool, useSupabase: false }, queueName!);
      console.log(`Stop signal sent for worker queue: ${queueName}`);
      await stopPool.end();
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
