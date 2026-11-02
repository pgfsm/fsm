import { getLogger } from "@logtape/logtape";
import {
  createFsmInstanceFromName,
  getFSMData,
  getFsmDataResolveStateValue,
  listFsmInstances,
  resumeEventForFsmWorker,
  sendEventToFsmQueueWithEventLogs,
  stopEventForFsmWorker,
} from "@pgfsm/db";
import type { Json } from "@pgfsm/db";
import { apiRequest, query } from "../api-client.ts";
import { type ApiTarget, resolveApiTarget } from "../api-target.ts";
import { parseCommandArgs, verbOf } from "../args.ts";
import { resolveDbUrl, withPool } from "../db-target.ts";
import { CtlError, ExitCode, notFound, usageError } from "../exit.ts";
import { CLI_INVOCATION } from "../invocation.ts";
import { CTL_CATEGORY } from "../logger.ts";
import { type OutputFormat, printList, printRecord } from "../output.ts";

const logger = getLogger([CTL_CATEGORY, "instance"]);

const VERBS = ["create", "resume", "send", "stop", "list", "get"] as const;
type WriteVerb = Exclude<typeof VERBS[number], "list" | "get">;
const STATUSES = ["active", "done", "error", "stopped"];

const HELP = `pgfsmctl instance — FSM instance control (kubectl equivalent)

USAGE
  ${CLI_INVOCATION} instance <create|resume|send|stop|list|get> [options]

VERBS
  create   Create a new FSM instance and enqueue it for scheduling
  resume   Re-enqueue an existing FSM instance for scheduling
  send     Send an event to a running FSM instance
  stop     Send a stop signal to a running fsmlet worker via pg_notify
  list     Instances, newest first, filtered in the database (#661)
  get      One instance: status, state, context, error (-o json: everything)

OPTIONS
  -q, --queue-name <id>          FSM instance ID (required for resume, send, stop, get)
  -n, --fsm-name <name>          FSM name (required for create; a filter for list)
  -V, --fsm-version <version>    FSM version (required for create; a filter for list)
      --status <status>          list: active, done, error or stopped
      --limit <n>                list: at most n, newest first (default 50, max 1000)
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
  PGFSM_URL, each with its key): POST /instances, POST
  /instances/<id>/resume, /events or /stop, GET /instances or GET
  /instances/<id>, with an operator or admin key (SPEC-009 phase 2, #660,
  #661; routes #675).
  Otherwise DB-direct (PGFSM_DB_URL or DATABASE_URL, or the profile's db_url),
  so a project's .env with only DATABASE_URL works with no API running.
  --db-url always means DB-direct, unless the tier is pinned to the API (a
  profile's tier: api, or PGFSM_TIER=api): then any DB-direct path exits 2
  (#663). The tier used is logged. Output and exit
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
      "status",
      "limit",
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
  } else if (verb !== "list" && !queueName) {
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

  if (verb === "list" || verb === "get") {
    return await readInstances(verb, args, {
      queueName,
      fsmName,
      fsmVersion,
      status: flag("status"),
      limit: flag("limit"),
    });
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
  verb: WriteVerb,
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

type InstanceRow = Record<string, unknown> & { id: string };

/** The columns `instance list` shows, the same on both tiers. */
function summary(r: InstanceRow) {
  return {
    id: r.id,
    fsm_name: r.fsm_name ?? null,
    fsm_version: r.fsm_version ?? null,
    status: r.fsm_instance_status ?? null,
    state: r.fsm_instance_state ?? null,
    started_at: r.started_at ?? null,
  };
}

/**
 * `instance list` / `instance get` (#661): the API's GET /instances[/<id>]
 * when an API target resolves, else DB-direct; --db-url forces DB-direct.
 */
async function readInstances(
  verb: "list" | "get",
  args: {
    output: OutputFormat;
    dbUrl?: string;
    url?: string;
    apiKey?: string;
    profile?: string;
  },
  a: {
    queueName?: string;
    fsmName?: string;
    fsmVersion?: string;
    status?: string;
    limit?: string;
  },
): Promise<void> {
  if (a.status !== undefined && !STATUSES.includes(a.status)) {
    throw usageError(
      `--status must be one of ${STATUSES.join(", ")}, got: ${a.status}`,
      HELP,
    );
  }
  const limit = a.limit === undefined ? 50 : Number(a.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw usageError(
      `--limit must be an integer from 1 to 1000, got: ${a.limit}`,
      HELP,
    );
  }

  const api = args.dbUrl ? undefined : await resolveApiTarget(args);
  if (api) {
    logger.info(`instance ${verb}: via the API at ${api.url} (${api.source})`);
  } else logger.info(`instance ${verb}: DB-direct`);

  if (verb === "list") {
    const filters = {
      fsmName: a.fsmName,
      fsmVersion: a.fsmVersion,
      status: a.status,
      limit,
    };
    const rows = api
      ? (await apiRequest<{ data: InstanceRow[] }>(
        api,
        "GET",
        `/instances${
          query({
            fsm_name: a.fsmName,
            fsm_version: a.fsmVersion,
            status: a.status,
            limit,
          })
        }`,
      )).data
      : await withPool(
        await resolveDbUrl(args),
        async (deps) =>
          (await listFsmInstances(deps, filters)) as unknown as InstanceRow[],
      );
    return printList(rows.map(summary), args.output, {
      columns: [
        "id",
        "fsm_name",
        "fsm_version",
        "status",
        "state",
        "started_at",
      ],
      id: (r) => r.id,
    });
  }

  const id = a.queueName!;
  type Got = { fsm_instance_row: InstanceRow; resolved_state_value: unknown };
  const got: Got | null = api
    ? (await apiRequest<{ data: Got }>(
      api,
      "GET",
      `/instances/${encodeURIComponent(id)}`,
    )).data
    : await withPool(await resolveDbUrl(args), async (deps) => {
      // get_fsm_data_resolve_state_value_v2 raises for an unknown id.
      if (!(await getFSMData(deps, id))) return null;
      return await getFsmDataResolveStateValue(deps, id) as unknown as Got;
    });
  if (!got) throw notFound(`FSM instance not found: ${id}`);
  const row = got.fsm_instance_row;
  printRecord(
    args.output === "json" ? { fsm_instance_id: id, ...got } : {
      fsm_instance_id: id,
      fsm_name: row.fsm_name ?? null,
      fsm_version: row.fsm_version ?? null,
      status: row.fsm_instance_status ?? null,
      state: row.fsm_instance_state ?? null,
      context: row.fsm_instance_context ?? null,
      error: row.fsm_instance_error ?? null,
      parent_fsm_instance_id: row.parent_fsm_instance_id ?? null,
      started_at: row.started_at ?? null,
      ended_at: row.ended_at ?? null,
    },
    args.output,
    { id: (r) => r.fsm_instance_id },
  );
}
