import { parseArgs } from "@std/cli/parse-args";
import { dirname, fromFileUrl, join, resolve } from "@std/path";
import dotenv from "dotenv";
import { Pool } from "pg";
import { getLogger } from "@logtape/logtape";
import { configureLogging, isTerminal } from "@pgfsm/logging";
import {
  generateAsyncOperationLogicFromFolders,
  generateFsmJSONFromFolders,
  generateSyncOperationLogicFromFolders,
} from "@pgfsm/compiler";
import { registerScheduleAllPendingCronJob } from "@pgfsm/db";
import { runSupervised } from "../supervisor.ts";
import type { ProcessSpec } from "../supervisor.ts";

dotenv.config({ path: ".env" });

// True under real Deno (this monorepo's dev flow); false under the dnt-built
// Node/npm output. Deliberately NOT `typeof Deno !== "undefined"` — dnt's
// shim always defines a global `Deno` polyfill, so that check is true under
// both runtimes. `Deno.execPath()` under that polyfill also resolves to a
// real system `deno` binary path (not this process's own), so it can't be
// used to decide how to spawn things either — verified empirically (see
// packages/fsm-devstack-ts/CLAUDE.md). `process.versions.deno` only exists
// under real Deno in either case, so it's the reliable signal.
const isDeno = typeof process !== "undefined" && !!process.versions?.deno;

const LOG_CATEGORY = "@pgfsm/devstack";
const logger = getLogger([LOG_CATEGORY, "fsmdev", "cli"]);
await configureLogging({
  levels: { [LOG_CATEGORY]: isTerminal ? "debug" : "info" },
});

// Long-running steps get their own self-owned runner file (imports the
// sibling package's library function directly, not that package's own CLI —
// see run-gateway.ts/run-fsmlet.ts's header comments for why), resolved
// relative to this file itself so it works whether @pgfsm/devstack lives in
// this monorepo or is installed via npm. dnt preserves this file's directory
// layout when it compiles run-gateway.ts/run-fsmlet.ts into dist/{esm,script}
// (verified empirically), so the same self-relative resolution works against
// their compiled .js siblings too — just with a different extension and a
// different command to run them with (see toProcessSpec below).
// generate-all/pgcron are one-shot, so they're called as plain library
// functions below instead — no subprocess needed either way.
const GATEWAY_CLI = new URL(
  `./run-gateway.${isDeno ? "ts" : "js"}`,
  import.meta.url,
);
const FSMLET_CLI = new URL(
  `./run-fsmlet.${isDeno ? "ts" : "js"}`,
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
  npx -p @pgfsm/devstack -- fsmdev -f <fsm-folder> [options]

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
  Brings up a full local FSM dev stack in one command, calling
  @pgfsm/compiler/@pgfsm/async-worker/@pgfsm/sync-worker's library
  functions directly rather than shelling out to their CLIs:
    1. generate-all (@pgfsm/compiler)                        — one-shot,
       in-process
    2. pgcron registration (@pgfsm/sync-worker)               — one-shot,
       idempotent, in-process
    3. the Activity Gateway (@pgfsm/async-worker) and fsmlet
       (@pgfsm/sync-worker) — each spawned as its own process (a small
       self-owned runner that imports the library function directly, see
       packages/fsm-devstack-ts/CLAUDE.md) and supervised together:
       Ctrl+C stops both, and if either exits unexpectedly the other is
       torn down (see that same doc for the failure policy).

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

// generate-all, folder mode — the exact sequence fsm-compiler-ts's own CLI
// runs for `-c generate-all`. One step's partial failure across some FSMs
// doesn't block the next step from running for the rest (see that CLI's
// "generate-all" case for why each is caught independently).
async function runGenerateAll(): Promise<string> {
  logger.info("Running generate-all...");
  const writeRootAbsPath = dirname(fsmFolder);
  const stepErrors: Error[] = [];

  try {
    await generateFsmJSONFromFolders(fsmFolder, [], false);
  } catch (err) {
    stepErrors.push(err instanceof Error ? err : new Error(String(err)));
  }
  try {
    await generateAsyncOperationLogicFromFolders(
      fsmFolder,
      [],
      "grpc",
      writeRootAbsPath,
    );
  } catch (err) {
    stepErrors.push(err instanceof Error ? err : new Error(String(err)));
  }
  try {
    await generateSyncOperationLogicFromFolders(fsmFolder, ["typescript"], []);
  } catch (err) {
    stepErrors.push(err instanceof Error ? err : new Error(String(err)));
  }

  if (stepErrors.length > 0) {
    for (const err of stepErrors) {
      logger.error("generate-all step failed: {error}", { error: err });
    }
    Deno.exit(1);
  }
  logger.info("generate-all completed.");
  return writeRootAbsPath;
}

// pgcron registration — one-shot, idempotent, matching @pgfsm/sync-worker's
// pgcron CLI (src/cli/pgcron.ts) exactly, minus its own argv/pool plumbing.
async function runPgcron(): Promise<void> {
  const resolvedDbUrl = dbUrl ?? Deno.env.get("DATABASE_URL") ?? "";
  if (!resolvedDbUrl) {
    logger.error(
      "DATABASE_URL is required for pgcron registration (set in .env or pass --db-url)",
    );
    Deno.exit(1);
  }
  logger.info("Running pgcron registration...");
  const pool = new Pool({ connectionString: resolvedDbUrl, max: 1 });
  try {
    await registerScheduleAllPendingCronJob(
      { db: pool, useSupabase: false },
      pgcronSchedule,
    );
    logger.info("pgcron registration completed.");
  } catch (err) {
    logger.error("pgcron registration failed: {error}", { error: err });
    Deno.exit(1);
  } finally {
    await pool.end();
  }
}

function toProcessSpec(
  name: string,
  scriptUrl: URL,
  scriptArgs: string[],
): ProcessSpec {
  const scriptPath = fromFileUrl(scriptUrl);
  if (isDeno) {
    return {
      name,
      cmd: Deno.execPath(),
      args: ["run", "--allow-all", scriptPath, ...scriptArgs],
    };
  }
  // Under the dnt-built Node output, invoke the compiled sibling .js file
  // directly with this process's own node binary — Deno.execPath() would
  // resolve to a real system `deno` binary here (see the isDeno comment
  // above), and there's no "run"/permission-flag step Node needs anyway.
  return {
    name,
    cmd: process.execPath,
    args: [scriptPath, ...scriptArgs],
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

// 1. generate-all — one-shot, must succeed before anything starts. Writes
// the aggregate worker SDK one level above --fsm-folder (the app root) — see
// fsm-compiler-ts/CLAUDE.md's "generate-async-logic" note.
const appRoot = await runGenerateAll();
printWorkerSdkStartInstructions(appRoot);

// 2. pgcron registration — one-shot, idempotent.
await runPgcron();

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
