import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";
import { Pool } from "pg";
import { getLogger } from "@logtape/logtape";
import { configureWorkerLogger } from "../logger.ts";
import { stopFSMWorker } from "../index.ts";
import { createFsmInstanceFromName, enqueueDispatch, getFsmDataResolveStateValue, getFSMData, sendEventToFsmQueueWithEventLogs, API_SYSTEM_QUEUE_UUID, API_SYSTEM_QUEUE_TYPE, API_SYSTEM_EVENT_NAME } from "@pgfsm/db";
import type { Json } from "@pgfsm/db";

const logger = getLogger(["@pgfsm/fsmctl"]);
await configureWorkerLogger();

const args = parseArgs(Deno.args, {
  string: ["command", "queue-name", "fsm-name", "fsm-version", "context", "event-type", "event-data", "db-url"],
  boolean: ["help"],
  alias: {
    h: "help",
    c: "command",
    q: "queue-name",
    n: "fsm-name",
    v: "fsm-version",
    e: "event-type",
    d: "db-url",
  },
});

function printHelp(): void {
  logger.info(`
fsmctl — FSM control CLI (kubectl equivalent)

USAGE
  deno run --allow-all src/cli/fsmctl.ts -c <command> [options]

COMMANDS
  create   Create a new FSM instance and enqueue it for the fsmscheduler
  resume   Enqueue an existing FSM instance to the fsmscheduler for resumption
  send     Send an event to a running FSM instance
  stop     Send a stop signal to a running fsmlet worker via pg_notify

OPTIONS
  -c, --command <command>        Command to run (required)
  -q, --queue-name <id>          FSM instance ID (required for resume, send, stop)
  -n, --fsm-name <name>          FSM name (required for create)
  -v, --fsm-version <version>    FSM version (required for create)
  -e, --event-type <type>        Event type to send (required for send)
      --context <json>           Initial FSM context as JSON string (optional, create only)
      --event-data <json>        Event payload as JSON string (optional, send only)
  -d, --db-url <url>             Database connection URL (overrides DATABASE_URL from .env)
  -h, --help                     Show this help message

EXAMPLES
  deno run --allow-all src/cli/fsmctl.ts -c create -n creditCheck -v 1
  deno run --allow-all src/cli/fsmctl.ts -c create -n creditCheck -v 1 --context '{"userId":"abc"}'
  deno run --allow-all src/cli/fsmctl.ts -c resume -q <instance-uuid>
  deno run --allow-all src/cli/fsmctl.ts -c send -q <instance-uuid> -e APPROVE
  deno run --allow-all src/cli/fsmctl.ts -c send -q <instance-uuid> -e APPROVE --event-data '{"reason":"ok"}'
  deno run --allow-all src/cli/fsmctl.ts -c stop -q <instance-uuid>
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
  logger.error("Missing required arguments: {missing}", { missing: missing.join(", ") });
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
          logger.error("--context is not valid JSON: {context}", { context: contextArg });
          Deno.exit(1);
        }
      }
      const pool = new Pool({ connectionString: resolvedDbUrl });
      const deps = { db: pool, useSupabase: false };
      // false = do not auto-enqueue to pgmq; we enqueue to fsm_dispatch_queue below.
      const result = await createFsmInstanceFromName(deps, fsmName!, fsmVersion!, context, false) as Record<string, string> | null;
      if (!result?.fsm_instance_id) {
        await pool.end();
        logger.error("Failed to create FSM instance.");
        Deno.exit(1);
      }
      await enqueueDispatch(deps, result.fsm_instance_id, fsmName!, fsmVersion!, "start");
      await pool.end();
      logger.info(result.fsm_instance_id);
      break;
    }

    case "resume": {
      const pool = new Pool({ connectionString: resolvedDbUrl });
      const deps = { db: pool, useSupabase: false };
      const fsmData = await getFsmDataResolveStateValue(deps, queueName!);
      if (!fsmData) {
        await pool.end();
        logger.error("FSM instance not found: {queueName}", { queueName });
        Deno.exit(1);
      }
      await enqueueDispatch(
        deps,
        queueName!,
        fsmData.fsm_instance_row.fsm_name ?? "",
        fsmData.fsm_instance_row.fsm_version ?? "",
        "resume",
      );
      await pool.end();
      break;
    }

    case "send": {
      let eventData: Json = {};
      if (eventDataArg) {
        try {
          eventData = JSON.parse(eventDataArg);
        } catch {
          logger.error("--event-data is not valid JSON: {eventData}", { eventData: eventDataArg });
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
      await stopFSMWorker({ db: pool, useSupabase: false }, queueName!);
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
