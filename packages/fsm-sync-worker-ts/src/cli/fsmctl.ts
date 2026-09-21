import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";
import { Pool } from "pg";
import { getLogger } from "@logtape/logtape";
import { configureWorkerLogger } from "../logger.ts";
import {
  API_SYSTEM_EVENT_NAME,
  API_SYSTEM_QUEUE_TYPE,
  API_SYSTEM_QUEUE_UUID,
  createFsmInstanceFromName,
  getFSMData,
  resumeEventForFsmWorker,
  sendEventToFsmQueueWithEventLogs,
  stopEventForFsmWorker,
} from "@pgfsm/db";
import type { Json } from "@pgfsm/db";
import { CLI_INVOCATION } from "./fsmctl-invocation.ts";
import { PACKAGE_VERSION } from "./version.ts";

const logger = getLogger(["@pgfsm/worker", "fsmctl"]);
await configureWorkerLogger();

const args = parseArgs(Deno.args, {
  string: [
    "command",
    "queue-name",
    "fsm-name",
    "fsm-version",
    "context",
    "event-type",
    "event-data",
    "db-url",
  ],
  boolean: ["help", "version"],
  alias: {
    h: "help",
    v: "version",
    c: "command",
    q: "queue-name",
    n: "fsm-name",
    V: "fsm-version",
    e: "event-type",
    d: "db-url",
  },
});

if (args.version) {
  // Bare, undecorated output (no logger timestamp/category prefix) — see
  // fsmlet.ts's identical --version handling.
  console.log(PACKAGE_VERSION);
  Deno.exit(0);
}

function printHelp(): void {
  logger.info(`
fsmctl — FSM control CLI (kubectl equivalent)

USAGE
  ${CLI_INVOCATION} -c <command> [options]

COMMANDS
  create   Create a new FSM instance and enqueue it for the fsmscheduler
  resume   Enqueue an existing FSM instance to the fsmscheduler for resumption
  send     Send an event to a running FSM instance
  stop     Send a stop signal to a running fsmlet worker via pg_notify

OPTIONS
  -c, --command <command>        Command to run (required)
  -q, --queue-name <id>          FSM instance ID (required for resume, send, stop)
  -n, --fsm-name <name>          FSM name (required for create)
  -V, --fsm-version <version>    FSM version (required for create)
  -e, --event-type <type>        Event type to send (required for send)
      --context <json>           Initial FSM context as JSON string (optional, create only)
      --event-data <json>        Event payload as JSON string (optional, send only)
  -d, --db-url <url>             Database connection URL (overrides DATABASE_URL from .env)
  -v, --version                  Print @pgfsm/sync-worker's version and exit
  -h, --help                     Show this help message

EXAMPLES
  ${CLI_INVOCATION} -c create -n creditCheck -V 1
  ${CLI_INVOCATION} -c create -n creditCheck -V 1 --context '{"userId":"abc"}'
  ${CLI_INVOCATION} -c resume -q <instance-uuid>
  ${CLI_INVOCATION} -c send -q <instance-uuid> -e APPROVE
  ${CLI_INVOCATION} -c send -q <instance-uuid> -e APPROVE --event-data '{"reason":"ok"}'
  ${CLI_INVOCATION} -c stop -q <instance-uuid>
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
const contextArg = args["context"];
const eventType = args["event-type"];
const eventDataArg = args["event-data"];
const dbUrl = args["db-url"];

const missing: string[] = [];
if (!command) missing.push("--command");

if (command === "create") {
  if (!fsmName) missing.push("--fsm-name");
  if (!fsmVersion) missing.push("--fsm-version");
}

if (command === "resume" || command === "send" || command === "stop") {
  if (!queueName) missing.push("--queue-name");
}

if (command === "send") {
  if (!eventType) missing.push("--event-type");
}

if (missing.length > 0) {
  logger.error("Missing required arguments: {missing}", {
    missing: missing.join(", "),
  });
  printHelp();
  Deno.exit(1);
}

dotenv.config({ path: ".env" });
const resolvedDbUrl = dbUrl ?? Deno.env.get("DATABASE_URL") ?? "";

// ── Commands ─────────────────────────────────────────────────────────────────

try {
  switch (command) {
    case "create": {
      let context: Json = {};
      if (contextArg) {
        try {
          context = JSON.parse(contextArg);
        } catch {
          logger.error("--context is not valid JSON: {context}", {
            context: contextArg,
          });
          Deno.exit(1);
        }
      }
      const pool = new Pool({ connectionString: resolvedDbUrl });
      const deps = { db: pool, useSupabase: false };
      // true = also create the instance's pgmq queue and send
      // initialTransition_event; the fsm_dispatch_queue enqueue alone only gets
      // a worker started for this instance — the worker then reads from the
      // per-instance pgmq queue, so that queue must exist and have a message.
      const result = await createFsmInstanceFromName(
        deps,
        fsmName!,
        fsmVersion!,
        context,
        true,
      ) as Record<string, string> | null;
      if (!result?.fsm_instance_id) {
        await pool.end();
        logger.error("Failed to create FSM instance.");
        Deno.exit(1);
      }
      await pool.end();
      logger.info("Created FSM instance: {result}", { result });
      break;
    }

    case "resume": {
      const pool = new Pool({ connectionString: resolvedDbUrl });
      const deps = { db: pool, useSupabase: false };
      const result = await resumeEventForFsmWorker(deps, queueName!);
      await pool.end();
      if (result.status === "fsm_not_found") {
        logger.error("FSM instance not found: {queueName}", { queueName });
        Deno.exit(1);
      }
      break;
    }

    case "send": {
      let eventData: Json = {};
      if (eventDataArg) {
        try {
          eventData = JSON.parse(eventDataArg);
        } catch {
          logger.error("--event-data is not valid JSON: {eventData}", {
            eventData: eventDataArg,
          });
          Deno.exit(1);
        }
      }
      const pool = new Pool({ connectionString: resolvedDbUrl });
      const deps = { db: pool, useSupabase: false };
      const fsmInstance = await getFSMData(deps, queueName!);
      if (!fsmInstance) {
        await pool.end();
        logger.error("FSM instance not found: {queueName}", { queueName });
        Deno.exit(1);
      }
      await sendEventToFsmQueueWithEventLogs(
        deps,
        queueName!,
        fsmInstance.fsm_type ?? null,
        fsmInstance.fsm_version ?? null,
        API_SYSTEM_QUEUE_UUID,
        API_SYSTEM_QUEUE_TYPE,
        API_SYSTEM_EVENT_NAME,
        eventType!,
        "external",
        { ...eventData as object, type: eventType } as Json,
        0,
      );
      await pool.end();
      break;
    }

    case "stop": {
      const pool = new Pool({ connectionString: resolvedDbUrl });
      await stopEventForFsmWorker({ db: pool, useSupabase: false }, queueName!);
      logger.info("Stop signal sent for worker: {queueName}", { queueName });
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
