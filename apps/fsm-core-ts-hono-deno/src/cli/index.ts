import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";

// logger.ts imports env.ts, which reads the environment once at import time,
// so it's loaded below, only after the flags have been copied into the env.
const logger = getLogger(["@pgfsm/api", "cli"]);

const args = parseArgs(Deno.args, {
  string: [
    "db-url",
    "url-path-prefix",
    "port",
    "env-file",
  ],
  boolean: ["help", "auth", "enable-admin-api"],
  negatable: ["auth"],
  default: { auth: true },
  alias: {
    h: "help",
    d: "db-url",
    p: "port",
    u: "url-path-prefix",
  },
});

function printHelp(): void {
  console.log(`
fsm-server — FSM Hono server CLI

The API serves HTTP only. Run fsmlets as separate workers (a generated worker
project's sync-worker), not in this process.

USAGE
  deno run --allow-all src/cli/index.ts [options]

OPTIONS
  -d, --db-url <url>                Database connection URL (overrides DATABASE_URL env var).
                                    With auth on, log in as fsm_authenticator in production.
  -u, --url-path-prefix <prefix>    URL path prefix for all routes (default: /fsm)
  -p, --port <port>                 Port to listen on (default: 9999)
      --no-auth                     Don't require API keys; every request runs as the
                                    database login. Local development only: refused when
                                    NODE_ENV=production. (env: PGFSM_NO_AUTH=true)
      --enable-admin-api            Mount /admin/* (FSM definition load, API keys). The
                                    database login must be able to act as fsm_admin.
                                    (env: PGFSM_ENABLE_ADMIN_API=true)
      --env-file <path>             Path to .env file (default: ./.env)
  -h, --help                        Show this help message

EXAMPLES
  # Minimal — DATABASE_URL and other vars come from .env; requires API keys
  deno run --allow-all src/cli/index.ts

  # Local development without keys
  deno run --allow-all src/cli/index.ts --no-auth

  # Internal admin deployment
  deno run --allow-all src/cli/index.ts --enable-admin-api \\
    --db-url postgres://fsm_authenticator:pass@db/postgres
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
const port = args["port"]
  ? Number(args["port"])
  : Number(Deno.env.get("PORT") ?? "9999");
const urlPathPrefix = args["url-path-prefix"] ?? "/fsm";

if (args["db-url"]) Deno.env.set("DATABASE_URL", args["db-url"]);
if (args["port"]) Deno.env.set("PORT", String(port));
if (!args.auth) Deno.env.set("PGFSM_NO_AUTH", "true");
if (args["enable-admin-api"]) Deno.env.set("PGFSM_ENABLE_ADMIN_API", "true");

if (!dbUrl) {
  console.error("--db-url is required (or set DATABASE_URL in the env file).");
  printHelp();
  Deno.exit(1);
}
Deno.env.set("DATABASE_URL", dbUrl);

const { configureApiLogger } = await import("../../logger.ts");
await configureApiLogger();

// ── Dynamic imports (after env vars are fully set) ───────────────────────────
// env.ts evaluates process.env at import time, so all overrides must be set first.

const { default: createApp } = await import("../../lib/create-app.ts");
// @ts-types="@types/pg"
const { Pool } = await import("pg");
const { Hono } = await import("hono");

// ── Start server ─────────────────────────────────────────────────────────────

const pool = new Pool({ connectionString: dbUrl });
let fsmRouter;
try {
  fsmRouter = await createApp(urlPathPrefix, { pool });
} catch (err) {
  logger.error("{error}", { error: (err as Error).message });
  await pool.end();
  Deno.exit(1);
}
const host = new Hono();
host.route(urlPathPrefix, fsmRouter);

logger.info("Starting FSM server on port {port} with prefix {prefix}", {
  port,
  prefix: urlPathPrefix,
});
const server = Deno.serve({ port }, host.fetch);

// ── Graceful / force shutdown ────────────────────────────────────────────────
// SIGTERM (Kubernetes) or Ctrl-C: stop accepting connections, let in-flight
// requests finish, close the pool, exit 0. A second signal force-exits (130).

let shutdownRequested = false;

const onSignal = async () => {
  if (shutdownRequested) {
    logger.info("Force exit.");
    Deno.exit(130);
  }
  shutdownRequested = true;
  logger.info(
    "Shutdown requested — stopping server gracefully. Ctrl+C again to force exit...",
  );
  await server.shutdown();
  await pool.end();
  logger.info("Server stopped.");
  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", onSignal);
// Windows only delivers SIGINT (and SIGBREAK) to Deno.
if (Deno.build.os !== "windows") Deno.addSignalListener("SIGTERM", onSignal);

self.addEventListener("error", (event) => {
  logger.error("Uncaught exception: {error}", { error: event.error });
  event.preventDefault();
});

self.addEventListener("unhandledrejection", (event) => {
  logger.error("Unhandled promise rejection: {reason}", {
    reason: event.reason,
  });
  event.preventDefault();
});
