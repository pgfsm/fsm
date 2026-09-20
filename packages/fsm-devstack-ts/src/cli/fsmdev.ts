import { parseArgs } from "@std/cli/parse-args";
import { dirname, fromFileUrl, join, resolve } from "@std/path";
import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { configureLogging, isTerminal } from "@pgfsm/logging";
import { runSupervised } from "../supervisor.ts";
import type { ProcessSpec } from "../supervisor.ts";

dotenv.config({ path: ".env" });

const LOG_CATEGORY = "@pgfsm/devstack";
const logger = getLogger([LOG_CATEGORY, "fsmdev", "cli"]);
await configureLogging({
  levels: { [LOG_CATEGORY]: isTerminal ? "debug" : "info" },
});

// Sibling CLIs this orchestrates, resolved relative to this package's
// location in the monorepo workspace (packages/fsm-devstack-ts/src/cli/).
const COMPILER_CLI = new URL(
  "../../../fsm-compiler-ts/src/cli/index.ts",
  import.meta.url,
);
const GATEWAY_CLI = new URL(
  "../../../fsm-core-async-op-worker/src/cli/async-operation-worker-gateway.ts",
  import.meta.url,
);
const FSMLET_CLI = new URL(
  "../../../fsm-sync-worker-ts/src/cli/fsmlet.ts",
  import.meta.url,
);
const PGCRON_CLI = new URL(
  "../../../fsm-sync-worker-ts/src/cli/pgcron.ts",
  import.meta.url,
);

const args = parseArgs(Deno.args, {
  string: [
    "fsm-folder",
    "db-url",
    "bind",
    "socket",
    "poll-interval-ms",
    "max-concurrency",
    "pgcron-schedule",
  ],
  boolean: ["help", "ensure-queue-on-register", "no-ensure-queue-on-register"],
  default: {
    bind: "unix:/tmp/pgfsm-activity-gateway.sock",
    socket: "/tmp/pgfsm-activity-gateway-workers.sock",
    "poll-interval-ms": "30000",
    "max-concurrency": "8",
    "pgcron-schedule": "5 seconds",
    "ensure-queue-on-register": true,
  },
  alias: {
    h: "help",
    f: "fsm-folder",
    d: "db-url",
    b: "bind",
    s: "socket",
    m: "max-concurrency",
  },
});

function printHelp(): void {
  logger.info(`
fsmdev — one-command local FSM dev stack (@pgfsm/devstack)

USAGE
  deno run --allow-all src/cli/fsmdev.ts -f <fsm-folder> [options]

OPTIONS
  -f, --fsm-folder <path>          FSM plugin-root folder, e.g. apps/fsm-core-example/fsm (required)
  -d, --db-url <url>               Database connection URL (overrides DATABASE_URL from .env)
  -b, --bind <target>              Gateway gRPC bind target (default: unix:/tmp/pgfsm-activity-gateway.sock)
  -s, --socket <path>              Unix socket between the gateway and worker processes
                                    (default: /tmp/pgfsm-activity-gateway-workers.sock)
      --poll-interval-ms <ms>      Gateway async-op poll loop interval (default: 30000)
      --ensure-queue-on-register   Ensure a PGMQ queue exists for every actor a worker registers
                                    (default: on for local dev; pass --no-ensure-queue-on-register to disable)
  -m, --max-concurrency <n>        fsmlet max concurrent FSM instances (default: 8)
      --pgcron-schedule <cron>     pg_cron schedule for the dispatch-drain job (default: "5 seconds")
  -h, --help                       Show this help message

DESCRIPTION
  Brings up a full local FSM dev stack in one command:
    1. generate-all (@pgfsm/compiler)                        — one-shot
    2. pgcron registration (@pgfsm/sync-worker)               — one-shot,
       idempotent
    3. async-operation-worker-gateway (@pgfsm/async-worker) and fsmlet
       (@pgfsm/sync-worker)                                   — supervised
       together: Ctrl+C stops both, and if either exits
       unexpectedly the other is torn down (see
       packages/fsm-devstack-ts/CLAUDE.md for the failure policy).

  Worker SDK processes (one per language actually generated —
  typescript/python/rust/go) are NOT started by fsmdev: they're
  polyglot, per-project generated code with different toolchains, so
  after generate-all runs, fsmdev prints the exact command to start
  each one yourself in its own terminal.

EXAMPLE
  deno run --allow-all src/cli/fsmdev.ts -f apps/fsm-core-example/fsm \\
    --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres
`);
}

if (args.help) {
  printHelp();
  Deno.exit(0);
}

const fsmFolderArg = args["fsm-folder"];
if (!fsmFolderArg) {
  logger.error("Missing required argument: --fsm-folder");
  printHelp();
  Deno.exit(1);
}

const fsmFolder = resolve(fsmFolderArg);
try {
  const stat = await Deno.stat(fsmFolder);
  if (!stat.isDirectory) {
    logger.error("--fsm-folder is not a directory: {path}", {
      path: fsmFolder,
    });
    Deno.exit(1);
  }
} catch {
  logger.error("--fsm-folder does not exist: {path}", { path: fsmFolder });
  Deno.exit(1);
}

const dbUrl = args["db-url"];
const bind = args.bind;
const socket = args.socket;
const pollIntervalMs = args["poll-interval-ms"];
// --no-ensure-queue-on-register always wins, regardless of flag order.
const ensureQueueOnRegister = !args["no-ensure-queue-on-register"] &&
  args["ensure-queue-on-register"];
const maxConcurrency = args["max-concurrency"];
const pgcronSchedule = args["pgcron-schedule"];

function dbArgs(): string[] {
  return dbUrl ? ["-d", dbUrl] : [];
}

async function runOnce(
  name: string,
  scriptUrl: URL,
  scriptArgs: string[],
): Promise<void> {
  logger.info("Running {name}...", { name });
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", fromFileUrl(scriptUrl), ...scriptArgs],
    stdout: "inherit",
    stderr: "inherit",
    stdin: "null",
  }).spawn();
  const status = await child.status;
  if (!status.success) {
    logger.error("{name} failed (exit code {code})", {
      name,
      code: status.code,
    });
    Deno.exit(status.code === 0 ? 1 : status.code);
  }
  logger.info("{name} completed.", { name });
}

function toProcessSpec(
  name: string,
  scriptUrl: URL,
  scriptArgs: string[],
): ProcessSpec {
  return {
    name,
    cmd: Deno.execPath(),
    args: ["run", "--allow-all", fromFileUrl(scriptUrl), ...scriptArgs],
  };
}

// How to start each generated worker-SDK language's process by hand — fsmdev
// doesn't launch these itself (see printHelp's DESCRIPTION for why).
const WORKER_SDK_START_COMMAND: Record<string, (dir: string) => string> = {
  typescript: (dir) =>
    `deno run --allow-all ${
      join(dir, "cli.ts")
    } start --gateway-socket ${socket}`,
  python: (dir) =>
    `python3 ${join(dir, "cli.py")} start --gateway-socket ${socket}`,
  rust: (dir) =>
    `(cd ${dir} && cargo run --release -- --gateway-socket ${socket})`,
  go: (dir) => `(cd ${dir} && go run . --gateway-socket ${socket})`,
};

function printWorkerSdkStartInstructions(appRoot: string): void {
  const workerSdkRoot = join(appRoot, "worker-sdk-generated");
  let entries: Deno.DirEntry[];
  try {
    entries = Array.from(Deno.readDirSync(workerSdkRoot));
  } catch {
    return; // no async-operation actors generated -- nothing to start
  }
  const langs = entries
    .filter((e) => e.isDirectory && e.name in WORKER_SDK_START_COMMAND)
    .map((e) => e.name)
    .sort();
  if (langs.length === 0) return;

  logger.info(
    "Generated worker SDK(s) — start each one yourself in its own terminal:",
  );
  for (const lang of langs) {
    logger.info("  {lang}: {command}", {
      lang,
      command: WORKER_SDK_START_COMMAND[lang](join(workerSdkRoot, lang)),
    });
  }
}

// 1. generate-all — one-shot, must succeed before anything starts.
await runOnce("generate-all", COMPILER_CLI, [
  "-c",
  "generate-all",
  "-f",
  fsmFolder,
]);

// generate-all writes the aggregate worker SDK one level above --folder (the
// app root) — see fsm-compiler-ts/CLAUDE.md's "generate-async-logic" note.
const appRoot = dirname(fsmFolder);
printWorkerSdkStartInstructions(appRoot);

// 2. pgcron registration — one-shot, idempotent.
await runOnce("pgcron", PGCRON_CLI, ["-s", pgcronSchedule, ...dbArgs()]);

// 3. gateway + fsmlet — supervised together. Worker SDK processes are
// started separately (see printWorkerSdkStartInstructions above).
const specs: ProcessSpec[] = [
  toProcessSpec("gateway", GATEWAY_CLI, [
    "-b",
    bind,
    "-s",
    socket,
    "--poll-interval-ms",
    pollIntervalMs,
    ...(ensureQueueOnRegister ? ["--ensure-queue-on-register"] : []),
    ...dbArgs(),
  ]),
  toProcessSpec("fsmlet", FSMLET_CLI, [
    "-f",
    fsmFolder,
    "-m",
    maxConcurrency,
    ...dbArgs(),
  ]),
];

logger.info("Starting supervised stack: {names}", {
  names: specs.map((s) => s.name).join(", "),
});
const exitCode = await runSupervised(specs);
Deno.exit(exitCode);
