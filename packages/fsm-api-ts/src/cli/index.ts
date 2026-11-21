import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { CLI_INVOCATION } from "./invocation.ts";
import { PACKAGE_VERSION } from "./version.ts";
import { logUncaught, startServer } from "./serve.ts";

// logger.ts imports env.ts, which reads the environment once at import time,
// so it's loaded below, only after the flags have been copied into the env.
const logger = getLogger(["@pgfsm/api", "cli"]);

const args = parseArgs(Deno.args, {
  string: [
    "db-url",
    "url-path-prefix",
    "port",
    "env-file",
    "name",
  ],
  boolean: ["help", "auth", "enable-admin-api", "force", "version"],
  negatable: ["auth"],
  default: { auth: true },
  alias: {
    h: "help",
    d: "db-url",
    p: "port",
    u: "url-path-prefix",
    v: "version",
  },
});

function printHelp(): void {
  console.log(`
pgfsm-api ${PACKAGE_VERSION} — the pgfsm REST API (/api/v1)

The API serves HTTP only. Run fsmlets as separate workers (a generated worker
project's sync-worker), not in this process.

USAGE
  ${CLI_INVOCATION} [serve] [options]        serve the API (the default)
  ${CLI_INVOCATION} key bootstrap [options]  create the first admin API key

SERVE OPTIONS
  -d, --db-url <url>                Database connection URL (overrides DATABASE_URL env var).
                                    With auth on, log in as fsm_authenticator in production.
  -u, --url-path-prefix <prefix>    URL path prefix for all routes (default: /api/v1)
  -p, --port <port>                 Port to listen on (default: 9999)
      --no-auth                     Don't require API keys; every request runs as the
                                    database login. Local development only: refused when
                                    NODE_ENV=production. (env: PGFSM_NO_AUTH=true)
      --enable-admin-api            Mount /admin/* (FSM definition load, API keys, the
                                    scheduler's pg_cron job). The database login must be
                                    able to act as fsm_admin. (env: PGFSM_ENABLE_ADMIN_API=true)
      --env-file <path>             Path to .env file (default: ./.env)

  GET / and the OpenAPI document report the API's licence (AGPL-3.0-only) and
  where its source is: https://github.com/pgfsm/fsm, or PGFSM_SOURCE_URL when
  you run a modified API (AGPL-3.0 section 13).

KEY BOOTSTRAP OPTIONS
  -d, --db-url <url>                The database owner's URL (the login that installed
                                    fsm_core), not the API's fsm_authenticator login.
      --name <name>                 The key's name (default: admin)
      --force                       Create one even though an admin key exists
                                    Prints only the key on stdout; it isn't shown again.

  -v, --version                     Print the version
  -h, --help                        Show this help message

EXAMPLES
  # Minimal — DATABASE_URL and other vars come from .env; requires API keys
  ${CLI_INVOCATION}

  # Local development without keys
  ${CLI_INVOCATION} --no-auth

  # Internal admin deployment
  ${CLI_INVOCATION} --enable-admin-api \\
    --db-url postgres://fsm_authenticator:pass@db/postgres

  # Once, after installing fsm_core: the first admin key
  ${CLI_INVOCATION} key bootstrap --db-url postgres://owner:pass@db/postgres
`);
}

if (args.help) {
  printHelp();
  Deno.exit(0);
}
if (args.version) {
  console.log(PACKAGE_VERSION);
  Deno.exit(0);
}

const command = args._.map(String);

// ── Load env file before anything else ──────────────────────────────────────

const envFile = args["env-file"] ?? "./.env";
dotenv.config({ path: envFile, quiet: true });

const dbUrl = args["db-url"] ?? Deno.env.get("DATABASE_URL");
if (!dbUrl) {
  console.error("--db-url is required (or set DATABASE_URL in the env file).");
  printHelp();
  Deno.exit(1);
}

if (command[0] === "key") {
  if (command[1] !== "bootstrap" || command.length > 2) {
    console.error(
      `Unknown command: key ${
        command.slice(1).join(" ")
      }. Expected: key bootstrap`,
    );
    Deno.exit(2);
  }
  // @ts-types="@types/pg"
  const { Pool } = await import("pg");
  const { requireFsmCoreVersion } = await import("@pgfsm/db");
  const { bootstrapAdminKey } = await import("./key-bootstrap.ts");
  const pool = new Pool({ connectionString: dbUrl, max: 1 });
  let code = 0;
  try {
    await requireFsmCoreVersion(pool, "pgfsm-api");
    const key = await bootstrapAdminKey(pool, {
      name: args.name ?? "admin",
      force: args.force,
    });
    console.error(
      `Created admin API key ${key.name} (${key.prefix}…). Store it now: it isn't shown again.`,
    );
    console.log(key.key);
  } catch (err) {
    console.error(`key bootstrap: ${(err as Error).message}`);
    code = 1;
  } finally {
    await pool.end();
  }
  Deno.exit(code);
}
if (command.length > 0 && !(command.length === 1 && command[0] === "serve")) {
  console.error(`Unknown command: ${command.join(" ")}. Run with --help.`);
  Deno.exit(2);
}

// CLI flags override env vars (must happen before dynamic imports that trigger env.ts)
const port = args["port"]
  ? Number(args["port"])
  : Number(Deno.env.get("PORT") ?? "9999");
const urlPathPrefix = args["url-path-prefix"] ?? "/api/v1";

if (args["port"]) Deno.env.set("PORT", String(port));
if (!args.auth) Deno.env.set("PGFSM_NO_AUTH", "true");
if (args["enable-admin-api"]) Deno.env.set("PGFSM_ENABLE_ADMIN_API", "true");
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
const { requireFsmCoreVersion } = await import("@pgfsm/db");
let fsmRouter;
try {
  // The database's fsm_core must be one this API supports (SPEC-016).
  await requireFsmCoreVersion(pool, "pgfsm-api");
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
const server = startServer(port, host.fetch);

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

logUncaught();
