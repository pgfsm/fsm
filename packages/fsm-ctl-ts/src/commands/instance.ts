import { parseArgs } from "@std/cli/parse-args";
import { getLogger } from "@logtape/logtape";
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
import { CLI_INVOCATION } from "../invocation.ts";
import { CTL_CATEGORY } from "../logger.ts";
import { resolveDbUrl, withPool } from "./db.ts";

const logger = getLogger([CTL_CATEGORY, "instance"]);

const VERBS = ["create", "resume", "send", "stop"] as const;
type Verb = typeof VERBS[number];

const HELP = `pgfsmctl instance — FSM instance control (kubectl equivalent)

USAGE
  ${CLI_INVOCATION} instance <create|resume|send|stop> [options]

VERBS
  create   Create a new FSM instance and enqueue it for scheduling
  resume   Re-enqueue an existing FSM instance for scheduling
  send     Send an event to a running FSM instance
  stop     Send a stop signal to a running fsmlet worker via pg_notify

OPTIONS
  -q, --queue-name <id>          FSM instance ID (required for resume, send, stop)
  -n, --fsm-name <name>          FSM name (required for create)
  -V, --fsm-version <version>    FSM version (required for create)
  -e, --event-type <type>        Event type to send (required for send)
      --context <json>           Initial FSM context as JSON string (optional, create only)
      --event-data <json>        Event payload as JSON string (optional, send only)
  -d, --db-url <url>             Database connection URL (overrides DATABASE_URL from .env)
  -h, --help                     Show this help

  Talks to the database directly (@pgfsm/db), not to the REST API.

EXAMPLES
  ${CLI_INVOCATION} instance create -n creditCheck -V v01
  ${CLI_INVOCATION} instance create -n creditCheck -V v01 --context '{"userId":"abc"}'
  ${CLI_INVOCATION} instance resume -q <instance-uuid>
  ${CLI_INVOCATION} instance send -q <instance-uuid> -e APPROVE
  ${CLI_INVOCATION} instance send -q <instance-uuid> -e APPROVE --event-data '{"reason":"ok"}'
  ${CLI_INVOCATION} instance stop -q <instance-uuid>
`;

function parseJsonFlag(flag: string, value: string | undefined): Json {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    logger.error(`${flag} is not valid JSON: {value}`, { value });
    Deno.exit(1);
  }
}

export async function instanceCommand(argv: string[]): Promise<void> {
  const args = parseArgs(argv, {
    string: [
      "queue-name",
      "fsm-name",
      "fsm-version",
      "context",
      "event-type",
      "event-data",
      "db-url",
    ],
    boolean: ["help"],
    alias: {
      h: "help",
      q: "queue-name",
      n: "fsm-name",
      V: "fsm-version",
      e: "event-type",
      d: "db-url",
    },
  });

  if (args.help) {
    console.log(HELP);
    Deno.exit(0);
  }

  const verbArg = args._[0] === undefined ? undefined : String(args._[0]);
  if (!VERBS.includes(verbArg as Verb)) {
    logger.error(
      verbArg === undefined
        ? "instance needs a verb: create, resume, send or stop"
        : `Unknown instance verb: ${verbArg}`,
    );
    console.log(HELP);
    Deno.exit(1);
  }
  const verb = verbArg as Verb;

  const queueName = args["queue-name"];
  const fsmName = args["fsm-name"];
  const fsmVersion = args["fsm-version"];
  const eventType = args["event-type"];

  const missing: string[] = [];
  if (verb === "create") {
    if (!fsmName) missing.push("--fsm-name");
    if (!fsmVersion) missing.push("--fsm-version");
  } else if (!queueName) {
    missing.push("--queue-name");
  }
  if (verb === "send" && !eventType) missing.push("--event-type");
  if (missing.length > 0) {
    logger.error("Missing required arguments: {missing}", {
      missing: missing.join(", "),
    });
    console.log(HELP);
    Deno.exit(1);
  }

  const context = verb === "create"
    ? parseJsonFlag("--context", args.context)
    : {};
  const eventData = verb === "send"
    ? parseJsonFlag("--event-data", args["event-data"])
    : {};
  const dbUrl = resolveDbUrl(args["db-url"]);

  let failure: string | undefined;
  try {
    await withPool(dbUrl, async (deps) => {
      switch (verb) {
        case "create": {
          // true = also create the instance's pgmq queue and send
          // initialTransition_event; the fsm_dispatch_queue enqueue alone
          // only gets a worker started for this instance — the worker then
          // reads from the per-instance pgmq queue, so that queue must exist
          // and have a message.
          const result = await createFsmInstanceFromName(
            deps,
            fsmName!,
            fsmVersion!,
            context,
            true,
          ) as Record<string, string> | null;
          if (!result?.fsm_instance_id) {
            failure = "Failed to create FSM instance.";
            return;
          }
          logger.info("Created FSM instance: {result}", { result });
          break;
        }

        case "resume": {
          const result = await resumeEventForFsmWorker(deps, queueName!);
          if (result.status === "fsm_not_found") {
            failure = `FSM instance not found: ${queueName}`;
          }
          break;
        }

        case "send": {
          const fsmInstance = await getFSMData(deps, queueName!);
          if (!fsmInstance) {
            failure = `FSM instance not found: ${queueName}`;
            return;
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
          break;
        }

        case "stop":
          await stopEventForFsmWorker(deps, queueName!);
          logger.info("Stop signal sent for worker: {queueName}", {
            queueName,
          });
          break;
      }
    });
  } catch (err) {
    logger.error("instance {verb} failed: {error}", { verb, error: err });
    Deno.exit(1);
  }

  if (failure) {
    logger.error(failure);
    Deno.exit(1);
  }
  logger.info("instance {verb} completed.", { verb });
}
