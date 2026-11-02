import { getLogger } from "@logtape/logtape";
import {
  createFsmInstanceFromName,
  getFSMData,
  resumeEventForFsmWorker,
  sendEventToFsmQueueWithEventLogs,
  stopEventForFsmWorker,
} from "@pgfsm/db";
import type { Json } from "@pgfsm/db";
import { apiRequest } from "../api-client.ts";
import { type ApiTarget, resolveApiTarget } from "../api-target.ts";
import { parseCommandArgs, verbOf } from "../args.ts";
import { resolveDbUrl, withPool } from "../db-target.ts";
import { CtlError, ExitCode, notFound, usageError } from "../exit.ts";
import { CLI_INVOCATION } from "../invocation.ts";
import { CTL_CATEGORY } from "../logger.ts";
import { printRecord } from "../output.ts";

const logger = getLogger([CTL_CATEGORY, "instance"]);

const VERBS = ["create", "resume", "send", "stop"] as const;

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
      --input <json>             Initial FSM context as JSON (optional, create only; xstate's input)
      --event-data <json>        Event payload as JSON string (optional, send only)
      --url <url>                API base URL incl. its path prefix, e.g. http://localhost:9999/api/v1
      --api-key <key>            Operator (or admin) key for the API
  -d, --db-url <url>             Postgres URL: forces DB-direct (break-glass)
      --profile <name>           Use this profile's url/api_key, or its db_url
  -o, --output <fmt>             table (default), json or ids
  -h, --help                     Show this help

TIER
  API when an API target resolves (--url, else the profile's url, else
  PGFSM_URL, each with its key): POST /instances, or POST
  /instances/<id>/resume, /events or /stop, with an operator or admin key
  (SPEC-009 phase 2, #660; routes #675).
  Otherwise DB-direct (PGFSM_DB_URL or DATABASE_URL, or the profile's db_url),
  so a project's .env with only DATABASE_URL works with no API running.
  --db-url always means DB-direct. The tier used is logged. Output and exit
  codes are the same on both tiers.

EXIT CODES
  2 bad or missing flags, 4 unknown instance, 3 permission denied

EXAMPLES
  ${CLI_INVOCATION} instance create -n creditCheck -V v01
  ${CLI_INVOCATION} instance create -n creditCheck -V v01 --input '{"userId":"abc"}'
  ${CLI_INVOCATION} instance resume -q <instance-uuid>
  ${CLI_INVOCATION} instance send -q <instance-uuid> -e APPROVE
  ${CLI_INVOCATION} instance send -q <instance-uuid> -e APPROVE --event-data '{"reason":"ok"}'
  ${CLI_INVOCATION} instance stop -q <instance-uuid>
`;

function parseJsonFlag(flag: string, value: unknown): Json {
  if (typeof value !== "string" || value === "") return {};
  try {
    return JSON.parse(value);
  } catch {
    throw usageError(`${flag} is not valid JSON: ${value}`, HELP);
  }
}

export async function instanceCommand(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, {
    string: [
      "queue-name",
      "fsm-name",
      "fsm-version",
      "input",
      "event-type",
      "event-data",
    ],
    alias: {
      q: "queue-name",
      n: "fsm-name",
      V: "fsm-version",
      e: "event-type",
    },
    common: ["db", "api", "output"],
  }, HELP);
  if (args.help) return console.log(HELP);

  const verb = verbOf("instance", args.positionals, VERBS, HELP);
  const flag = (name: string) => args.flags[name] as string | undefined;
  const queueName = flag("queue-name");
  const fsmName = flag("fsm-name");
  const fsmVersion = flag("fsm-version");
  const eventType = flag("event-type");

  const missing: string[] = [];
  if (verb === "create") {
    if (!fsmName) missing.push("--fsm-name");
    if (!fsmVersion) missing.push("--fsm-version");
  } else if (!queueName) {
    missing.push("--queue-name");
  }
  if (verb === "send" && !eventType) missing.push("--event-type");
  if (missing.length > 0) {
    throw usageError(`Missing required arguments: ${missing.join(", ")}`, HELP);
  }
  const UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (queueName !== undefined && !UUID.test(queueName)) {
    throw usageError(
      `--queue-name must be an instance UUID, got: ${queueName}`,
      HELP,
    );
  }

  const input = verb === "create"
    ? parseJsonFlag("--input", flag("input"))
    : {};
  const eventData = verb === "send"
    ? parseJsonFlag("--event-data", flag("event-data"))
    : {};
  const id = (r: { fsm_instance_id: string }) => r.fsm_instance_id;

  // --db-url forces DB-direct; otherwise the API wins whenever it resolves.
  const api = args.dbUrl ? undefined : await resolveApiTarget(args);
  if (api) {
    logger.info(`instance ${verb}: via the API at ${api.url} (${api.source})`);
    const record = await viaApi(api, verb, {
      queueName,
      fsmName,
      fsmVersion,
      eventType,
      input,
      eventData,
    });
    return printRecord(record, args.output, { id });
  }

  const dbUrl = await resolveDbUrl(args);
  logger.info(`instance ${verb}: DB-direct`);

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
          input,
          true,
        ) as Record<string, string> | null;
        if (!result?.fsm_instance_id) {
          throw new CtlError(
            ExitCode.GENERAL,
            "Failed to create FSM instance.",
          );
        }
        logger.info("Created FSM instance {id}", {
          id: result.fsm_instance_id,
        });
        printRecord(
          result as Record<string, string> & { fsm_instance_id: string },
          args.output,
          { id },
        );
        break;
      }

      case "resume": {
        const result = await resumeEventForFsmWorker(deps, queueName!);
        if (result.status === "fsm_not_found") {
          throw notFound(`FSM instance not found: ${queueName}`);
        }
        printRecord(result, args.output, { id });
        break;
      }

      case "send": {
        const fsmInstance = await getFSMData(deps, queueName!);
        if (!fsmInstance) {
          throw notFound(`FSM instance not found: ${queueName}`);
        }
        await sendEventToFsmQueueWithEventLogs(
          deps,
          queueName!,
          fsmInstance.fsm_type ?? null,
          fsmInstance.fsm_version ?? null,
          eventType!,
          "external",
          { ...eventData as object, type: eventType } as Json,
          0,
        );
        printRecord(
          { fsm_instance_id: queueName!, event_type: eventType!, sent: true },
          args.output,
          { id },
        );
        break;
      }

      case "stop": {
        if (!(await getFSMData(deps, queueName!))) {
          throw notFound(`FSM instance not found: ${queueName}`);
        }
        await stopEventForFsmWorker(deps, queueName!);
        logger.info("Stop signal sent for worker: {queueName}", { queueName });
        printRecord(
          { fsm_instance_id: queueName!, stop_signal_sent: true },
          args.output,
          { id },
        );
        break;
      }
    }
  });
}

/**
 * The API tier (SPEC-009 phase 2, #660): the same verbs over the REST API,
 * printing the same records as DB-direct. HTTP errors map to exit codes in
 * apiRequest (401/403 → 3, 404 → 4).
 */
async function viaApi(
  api: ApiTarget,
  verb: typeof VERBS[number],
  a: {
    queueName?: string;
    fsmName?: string;
    fsmVersion?: string;
    eventType?: string;
    input: Json;
    eventData: Json;
  },
): Promise<Record<string, unknown> & { fsm_instance_id: string }> {
  switch (verb) {
    case "create": {
      const { data } = await apiRequest<
        {
          data: (Record<string, unknown> & { fsm_instance_id?: string }) | null;
        }
      >(api, "POST", "/instances", {
        fsm_name: a.fsmName,
        fsm_version: a.fsmVersion,
        input: a.input,
      });
      if (!data?.fsm_instance_id) {
        throw new CtlError(ExitCode.GENERAL, "Failed to create FSM instance.");
      }
      logger.info("Created FSM instance {id}", { id: data.fsm_instance_id });
      return data as Record<string, unknown> & { fsm_instance_id: string };
    }
    case "resume": {
      const { data } = await apiRequest<
        { data: Record<string, unknown> & { fsm_instance_id: string } }
      >(api, "POST", `${instancePath(a.queueName!)}/resume`);
      return data;
    }
    case "send": {
      await apiRequest(api, "POST", `${instancePath(a.queueName!)}/events`, {
        ...a.eventData as object,
        type: a.eventType,
      });
      return {
        fsm_instance_id: a.queueName!,
        event_type: a.eventType!,
        sent: true,
      };
    }
    case "stop": {
      await apiRequest(api, "POST", `${instancePath(a.queueName!)}/stop`);
      logger.info("Stop signal sent for worker: {queueName}", {
        queueName: a.queueName,
      });
      return { fsm_instance_id: a.queueName!, stop_signal_sent: true };
    }
  }
}

/** `/instances/<id>`, the id escaped. */
const instancePath = (id: string) => `/instances/${encodeURIComponent(id)}`;
