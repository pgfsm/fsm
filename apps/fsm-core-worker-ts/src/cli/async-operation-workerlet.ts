import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { configureWorkerLogger } from "../logger.ts";
import { runAsyncOperationWorkerlet } from "../asyncOperationWorkerlet/asyncOperationWorkerlet.ts";
import type { OperationLang, WorkflowType } from "@pgfsm/compiler";

const logger = getLogger(["@pgfsm/worker", "async-op-workerlet", "cli"]);
await configureWorkerLogger();

const args = parseArgs(Deno.args, {
  string: [
    "folder-path",
    "db-url",
    "max-concurrency",
    "workerlet-id",
    "workflow-type",
    "runtime-languages",
  ],
  boolean: ["help"],
  alias: {
    h: "help",
    f: "folder-path",
    d: "db-url",
    m: "max-concurrency",
    i: "workerlet-id",
    t: "workflow-type",
    l: "runtime-languages",
  },
});

const VALID_WORKFLOW_TYPES: WorkflowType[] = ["promise", "sharedPromise"];
const VALID_LANGS: OperationLang[] = ["typescript", "python", "go", "rust"];

function printHelp(): void {
  logger.info(`
async-operation-workerlet — async-operation node agent

USAGE
  deno run --allow-all src/cli/async-operation-workerlet.ts -f <folder-path> -l <langs> [options]

OPTIONS
  -f, --folder-path <path>          Absolute path to FSM folder (required)
  -l, --runtime-languages <langs>   Comma-separated languages to validate, e.g. typescript,python (required)
  -d, --db-url <url>                Database connection URL (overrides DATABASE_URL from .env)
  -m, --max-concurrency <n>         Max concurrent queue-workers (default 8)
  -i, --workerlet-id <id>           Stable workerlet identity (default: random UUID per startup)
  -t, --workflow-type <type>        Workflow type: ${
    VALID_WORKFLOW_TYPES.join(" | ")
  } (default: promise)
  -h, --help                        Show this help message

DESCRIPTION
  Validates async operations in the given folder for the specified runtime languages,
  loads them into async_operation_meta, registers itself in async_operation_workerlet,
  then listens for scheduled work via pg_notify. On each notification it atomically
  claims a dispatch entry and starts a long-running promise worker for that actor queue.
  Sends heartbeats every 5 s. Deregisters cleanly on shutdown.

EXAMPLE
  deno run --allow-all src/cli/async-operation-workerlet.ts \\
    --folder-path /abs/path/to/fsm-core-example/fsm \\
    --runtime-languages typescript \\
    --workflow-type promise
`);
}

if (args.help) {
  printHelp();
  Deno.exit(0);
}

const folderPath = args["folder-path"];
const dbUrl = args["db-url"];
const maxConcurrencyArg = args["max-concurrency"];
const workerletId = args["workerlet-id"] ??
  Deno.env.get("ASYNC_OP_WORKERLET_ID");
const workflowTypeArg = args["workflow-type"] ?? "promise";
const runtimeLanguagesArg = args["runtime-languages"];

if (!VALID_WORKFLOW_TYPES.includes(workflowTypeArg as WorkflowType)) {
  logger.error(
    "--workflow-type must be one of: {valid}. Got: {got}",
    { valid: VALID_WORKFLOW_TYPES.join(", "), got: workflowTypeArg },
  );
  Deno.exit(1);
}
const workflowType = workflowTypeArg as WorkflowType;

if (!runtimeLanguagesArg) {
  logger.error(
    "--runtime-languages is required. Provide a comma-separated list, e.g. typescript or typescript,python",
  );
  printHelp();
  Deno.exit(1);
}

const runtimeLanguages = runtimeLanguagesArg
  .split(",")
  .map((l) => l.trim())
  .filter(Boolean) as OperationLang[];

const invalidLangs = runtimeLanguages.filter((l) => !VALID_LANGS.includes(l));
if (invalidLangs.length > 0) {
  logger.error(
    "--runtime-languages contains invalid values: {invalid}. Valid: {valid}",
    { invalid: invalidLangs.join(", "), valid: VALID_LANGS.join(", ") },
  );
  Deno.exit(1);
}

const DEFAULT_MAX_CONCURRENCY = 8;
const maxConcurrency = maxConcurrencyArg
  ? Number(maxConcurrencyArg)
  : DEFAULT_MAX_CONCURRENCY;
if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
  logger.error("--max-concurrency must be a positive integer, got: {value}", {
    value: maxConcurrencyArg,
  });
  Deno.exit(1);
}

if (!folderPath) {
  logger.error("--folder-path is required");
  printHelp();
  Deno.exit(1);
}

try {
  await Deno.stat(folderPath);
} catch {
  logger.error("--folder-path does not exist: {path}", { path: folderPath });
  Deno.exit(1);
}

dotenv.config({ path: ".env" });
const resolvedDbUrl = dbUrl ?? Deno.env.get("DATABASE_URL") ?? "";

const controller = new AbortController();
let shutdownRequested = false;

const onSignal = () => {
  if (shutdownRequested) {
    logger.info("Force exit.");
    Deno.exit(0);
  }
  shutdownRequested = true;
  logger.info(
    "Shutdown requested — stopping async-operation workerlet gracefully. Ctrl+C again to force exit...",
  );
  controller.abort();
};

Deno.addSignalListener("SIGINT", onSignal);
Deno.addSignalListener("SIGTERM", onSignal);

try {
  logger.info(
    "Starting async-operation-workerlet: folder={path}, workflow-type={type}, langs={langs}, max-concurrency={max}, workerlet-id={id}",
    {
      path: folderPath,
      type: workflowType,
      langs: runtimeLanguages.join(", "),
      max: maxConcurrency,
      id: workerletId,
    },
  );
  await runAsyncOperationWorkerlet(
    { connectionString: resolvedDbUrl },
    folderPath,
    workflowType,
    { signal: controller.signal, maxConcurrency, workerletId },
    [],
    [],
    runtimeLanguages,
  );
  logger.info("AsyncOperationWorkerlet stopped.");
} catch (err) {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  logger.error("AsyncOperationWorkerlet failed: {error}", { error: msg });
  Deno.exit(1);
}
