import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";
import { Pool } from "pg";
import { getLogger } from "@logtape/logtape";
import { table } from "@pgfsm/logging";
import { configureWorkerLogger } from "../logger.ts";
import {
  createAsyncOperationInstanceAndNotifyAsyncOperationSchedulerWork,
  listAsyncOperationInstances,
  listAsyncOperationMeta,
} from "@pgfsm/db";

const logger = getLogger(["@pgfsm/worker", "async-operation-ctl"]);
await configureWorkerLogger();

const args = parseArgs(Deno.args, {
  string: [
    "command",
    "instance-id",
    "name",
    "version",
    "type",
    "parent-fsm-name",
    "parent-fsm-version",
    "language",
    "db-url",
  ],
  boolean: ["help"],
  alias: {
    h: "help",
    c: "command",
    n: "name",
    v: "version",
    t: "type",
    l: "language",
    d: "db-url",
  },
});

function printHelp(): void {
  logger.info(`
async-operation-ctl — async-operation control CLI (kubectl equivalent)

USAGE
  deno run --allow-all src/cli/async-operation-ctl.ts -c <command> [options]

COMMANDS
  list-instances   List all rows in async_operation_instance_and_async_operation_workerlet
  list-meta        List all rows in async_operation_meta
  dispatch         Enqueue an async-operation instance and notify the async-operation-scheduler

OPTIONS
  -c, --command <command>              Command to run (required)
      --instance-id <uuid>             Async-operation instance ID (dispatch only; default: random UUID)
  -n, --name <name>                    Async-operation name (required for dispatch)
  -v, --version <version>              Async-operation version (required for dispatch)
  -t, --type <type>                    Async-operation type, e.g. promise | sharedPromise (required for dispatch)
      --parent-fsm-name <name>         Parent FSM name (required for dispatch)
      --parent-fsm-version <version>   Parent FSM version (required for dispatch)
  -l, --language <lang>                Async-operation language, e.g. typescript (required for dispatch)
  -d, --db-url <url>                   Database connection URL (overrides DATABASE_URL from .env)
  -h, --help                           Show this help message

EXAMPLES
  deno run --allow-all src/cli/async-operation-ctl.ts -c list-instances
  deno run --allow-all src/cli/async-operation-ctl.ts -c list-meta
  deno run --allow-all src/cli/async-operation-ctl.ts -c dispatch \\
    -n checkBureau -v 1 -t promise \\
    --parent-fsm-name creditCheck --parent-fsm-version 1 \\
    -l typescript
`);
}

if (args.help) {
  printHelp();
  Deno.exit(0);
}

const command = args["command"];
const instanceIdArg = args["instance-id"];
const name = args["name"];
const version = args["version"];
const type = args["type"];
const parentFsmName = args["parent-fsm-name"];
const parentFsmVersion = args["parent-fsm-version"];
const language = args["language"];
const dbUrl = args["db-url"];

const missing: string[] = [];
if (!command) missing.push("--command");

if (command === "dispatch") {
  if (!name) missing.push("--name");
  if (!version) missing.push("--version");
  if (!type) missing.push("--type");
  if (!parentFsmName) missing.push("--parent-fsm-name");
  if (!parentFsmVersion) missing.push("--parent-fsm-version");
  if (!language) missing.push("--language");
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
    case "list-instances": {
      const pool = new Pool({ connectionString: resolvedDbUrl });
      const deps = { db: pool, useSupabase: false };
      const rows = await listAsyncOperationInstances(deps);
      await pool.end();
      logger.info("{count} async-operation instance(s)", {
        count: rows.length,
        ...table(rows),
      });
      break;
    }

    case "list-meta": {
      const pool = new Pool({ connectionString: resolvedDbUrl });
      const deps = { db: pool, useSupabase: false };
      const rows = await listAsyncOperationMeta(deps);
      await pool.end();
      logger.info("{count} async-operation meta row(s)", {
        count: rows.length,
        ...table(rows),
      });
      break;
    }

    case "dispatch": {
      const pool = new Pool({ connectionString: resolvedDbUrl });
      const deps = { db: pool, useSupabase: false };
      const asyncOperationInstanceId = instanceIdArg ?? crypto.randomUUID();
      await createAsyncOperationInstanceAndNotifyAsyncOperationSchedulerWork(
        deps,
        {
          asyncOperationInstanceId,
          asyncOperationName: name!,
          asyncOperationVersion: version!,
          asyncOperationType: type!,
          parentFsmName: parentFsmName!,
          parentFsmVersion: parentFsmVersion!,
          asyncOperationLanguage: language!,
        },
      );
      await pool.end();
      logger.info(asyncOperationInstanceId);
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
