import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { configureApiLogger } from "../../logger.ts";
import type { FsmStartupConfig } from "../../lib/types.ts";

const logger = getLogger(["@pgfsm/api", "cli"]);
await configureApiLogger();

const args = parseArgs(Deno.args, {
  string: [
    "db-url",
    "url-path-prefix",
    "port",
    "shared-promise-path",
    "shared-fsm-path",
    "fsm-path",
    "env-file",
  ],
  boolean: ["help"],
  alias: {
    h: "help",
    d: "db-url",
    p: "port",
    u: "url-path-prefix",
  },
});

function printHelp(): void {
  logger.info(`
fsm-server — FSM Hono server CLI

USAGE
  deno run --allow-all src/cli/index.ts [options]

OPTIONS
  -d, --db-url <url>                Database connection URL (overrides DATABASE_URL env var)
  -u, --url-path-prefix <prefix>    URL path prefix for all routes (default: /fsm)
  -p, --port <port>                 Port to listen on (default: 9999)
      --shared-promise-path <path>  Absolute path to sharedPromise FSM folder
      --shared-fsm-path <path>      Absolute path to sharedFsm FSM folder
      --fsm-path <path>             Absolute path to fsm FSM folder
      --env-file <path>             Path to .env file (default: ./.env)
  -h, --help                        Show this help message

EXAMPLES
  # Minimal — DATABASE_URL and other vars come from .env
  deno run --allow-all src/cli/index.ts

  # Override DB URL and port
  deno run --allow-all src/cli/index.ts --db-url postgres://user:pass@localhost/db --port 8080

  # Full config with FSM folder paths and custom prefix
  deno run --allow-all src/cli/index.ts \\
    --db-url postgres://user:pass@localhost/db \\
    --url-path-prefix /api/fsm \\
    --port 8080 \\
    --shared-promise-path /abs/path/to/sharedPromise \\
    --shared-fsm-path /abs/path/to/sharedFSM \\
    --fsm-path /abs/path/to/fsm

  # Use a custom env file
  deno run --allow-all src/cli/index.ts --env-file /path/to/.env --fsm-path /abs/path/to/fsm
`);
}

if (args.help) {
  printHelp();
  Deno.exit(0);
}

// ── Load env file before anything else ──────────────────────────────────────

const envFile = args["env-file"] ?? "./.env";
dotenv.config({ path: envFile });

// CLI flags override env vars (must happen before dynamic imports that trigger env.ts)
const dbUrl = args["db-url"] ?? Deno.env.get("DATABASE_URL");
const port = args["port"] ? Number(args["port"]) : Number(Deno.env.get("PORT") ?? "9999");
const urlPathPrefix = args["url-path-prefix"] ?? "/fsm";

if (args["db-url"]) Deno.env.set("DATABASE_URL", args["db-url"]);
if (args["port"]) Deno.env.set("PORT", String(port));

if (!dbUrl) {
  logger.error("--db-url is required (or set DATABASE_URL in the env file).");
  printHelp();
  Deno.exit(1);
}

// Validate that FSM paths exist if provided
const pathsToCheck: Array<[string, string]> = [];
if (args["shared-promise-path"]) pathsToCheck.push(["--shared-promise-path", args["shared-promise-path"]]);
if (args["shared-fsm-path"]) pathsToCheck.push(["--shared-fsm-path", args["shared-fsm-path"]]);
if (args["fsm-path"]) pathsToCheck.push(["--fsm-path", args["fsm-path"]]);

for (const [flag, path] of pathsToCheck) {
  try {
    await Deno.stat(path);
  } catch {
    logger.error("{flag} path does not exist: {path}", { flag, path });
    Deno.exit(1);
  }
}

// ── Dynamic imports (after env vars are fully set) ───────────────────────────
// env.ts evaluates process.env at import time, so all overrides must be set first.

const { default: createApp } = await import("../../lib/create-app.ts");
const { Pool } = await import("pg");
const { Hono } = await import("hono");

// ── Build FSM config from CLI flags ─────────────────────────────────────────

const fsmConfig: FsmStartupConfig = {};
if (args["shared-promise-path"]) {
  fsmConfig.sharedPromise = { folderPath: args["shared-promise-path"], skipDirs: [] };
}
if (args["shared-fsm-path"]) {
  fsmConfig.sharedFsm = { folderPath: args["shared-fsm-path"], skipDirs: [] };
}
if (args["fsm-path"]) {
  fsmConfig.fsm = { folderPath: args["fsm-path"], skipDirs: [] };
}

// ── Graceful / force shutdown ────────────────────────────────────────────────

let shutdownRequested = false;

const onSignal = () => {
  if (shutdownRequested) {
    logger.info("Force exit.");
    Deno.exit(0);
  }
  shutdownRequested = true;
  logger.info("Shutdown requested — stopping server gracefully. Ctrl+C again to force exit...");
};

Deno.addSignalListener("SIGINT", onSignal);
Deno.addSignalListener("SIGTERM", onSignal);

// ── Start server ─────────────────────────────────────────────────────────────

const pool = new Pool({ connectionString: dbUrl });
const fsmRouter = await createApp(pool, urlPathPrefix, fsmConfig);
const host = new Hono();
host.route(urlPathPrefix, fsmRouter);

logger.info("Starting FSM server on port {port} with prefix {prefix}", { port, prefix: urlPathPrefix });
Deno.serve({ port }, host.fetch);

self.addEventListener("error", (event) => {
  logger.error("Uncaught exception: {error}", { error: event.error });
  event.preventDefault();
});

self.addEventListener("unhandledrejection", (event) => {
  logger.error("Unhandled promise rejection: {reason}", { reason: event.reason });
  event.preventDefault();
});
