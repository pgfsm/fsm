import { cors } from "hono/cors";
import { getLogger } from "@logtape/logtape";
import { Pool } from "pg";

import { requestId } from "hono/request-id";
import {
  notFound,
  onError,
  serveEmojiFavicon,
} from "stoker/middlewares/index.ts";

import configureOpenAPI from "./configure-open-api.ts";
import { createRouter } from "./create-router.ts";

// import { pinoLogger } from "./../middlewares/pino-logger.ts";
import { logtapeLogger } from "./../middlewares/logtape-logger.ts";
import { otelTrace } from "./../middlewares/otel-trace.ts";
import { apiKeyAuth } from "../middlewares/api-key-auth.ts";

import { supabaseMiddleware } from "../middlewares/supabase.ts";
import env from "../env.ts";

import index from "../routes/index.route.ts";
import fsm from "../routes/fsm/fsm.index.ts";
import admin from "../routes/admin/admin.index.ts";

export { createRouter };

const logger = getLogger(["@pgfsm/api", "app"]);

export type CreateAppOptions = {
  /** Pool the API runs requests on. Default: a new Pool on DATABASE_URL. */
  pool?: Pool;
  /** Require API keys (SPEC-009 §3). Default: on, unless PGFSM_NO_AUTH. */
  auth?: boolean;
  /** Mount /admin/* routes. Default: PGFSM_ENABLE_ADMIN_API. */
  adminApi?: boolean;
  /** Key-verification cache TTL in ms. Default: PGFSM_AUTH_CACHE_TTL_MS. */
  authCacheTtlMs?: number;
};

/**
 * The REST API. It only serves HTTP: fsmlets run as separate worker
 * processes (root CLAUDE.md #3; the API used to embed one, which stopped
 * compiling once the fsmlet moved to compiled registries in #341).
 */
export default async function createApp(
  basePath = "",
  options: CreateAppOptions = {},
) {
  const auth = options.auth ?? !env.PGFSM_NO_AUTH;
  const adminApi = options.adminApi ?? env.PGFSM_ENABLE_ADMIN_API;
  const authCacheTtlMs = options.authCacheTtlMs ??
    env.PGFSM_AUTH_CACHE_TTL_MS;

  if (!auth && env.NODE_ENV === "production") {
    throw new Error(
      "createApp: --no-auth / PGFSM_NO_AUTH is for local development and refused when NODE_ENV=production",
    );
  }
  if (auth && env.DB_TYPE !== "postgres") {
    throw new Error(
      `createApp: API-key auth needs DB_TYPE=postgres (got ${env.DB_TYPE}); the Supabase client path doesn't run requests under the key's role yet`,
    );
  }

  const pool = options.pool ??
    new Pool({ connectionString: env.DATABASE_URL });
  pool.on("connect", () => {
    logger.debug("Database pool: new connection established");
  });
  pool.on("error", (err: Error) => {
    logger.error("Database pool error: {error}", { error: err });
  });

  await checkPoolLogin(pool, { auth, adminApi });

  const app = createRouter();

  const otelEnabled = env.OTEL_DENO === "true" &&
    !!env.OTEL_EXPORTER_OTLP_ENDPOINT;

  // app.use(requestId()).use(serveEmojiFavicon("📝")).use(pinoLogger());
  app.use(requestId()).use(serveEmojiFavicon("📝")).use(logtapeLogger());
  if (otelEnabled) app.use(otelTrace());
  app.use("*", (c, next) => {
    const corsMiddlewareHandler = cors({
      origin: env.CORS_ORIGIN,
    });
    return corsMiddlewareHandler(c, next);
  });

  if (auth) {
    // Each request runs in withRole(key's role); the middleware sets `db` to
    // that transaction. Routes outside these paths (index, docs) get no db.
    const operator = apiKeyAuth({
      pool,
      requiredRole: "fsm_operator",
      cacheTtlMs: authCacheTtlMs,
    });
    app.use("/fsm", operator);
    app.use("/fsm/*", operator);
    if (adminApi) {
      app.use(
        "/admin/*",
        apiKeyAuth({
          pool,
          requiredRole: "fsm_admin",
          cacheTtlMs: authCacheTtlMs,
        }),
      );
    }
  } else {
    logger.warn(
      "API-key auth is OFF (--no-auth): every request runs as the pool's login role. Local development only.",
    );
    if (env.DB_TYPE === "supabase") {
      app.use("*", supabaseMiddleware());
    } else if (env.DB_TYPE === "postgres") {
      app.use("*", (c, next) => {
        c.set("db", pool);
        return next();
      });
    } else if (env.DB_TYPE === "supabase_and_postgres") {
      app.use("*", supabaseMiddleware());
      app.use("*", (c, next) => {
        c.set("db", pool);
        return next();
      });
    }
  }

  app.notFound(notFound);
  app.onError(onError);

  const routes = adminApi
    ? [index, fsm, admin] as const
    : [index, fsm] as const;
  routes.forEach((route) => {
    app.route("/", route);
  });

  configureOpenAPI(app, basePath);

  logger.info(
    "API ready: auth {auth}, admin API {admin}",
    { auth: auth ? "on" : "OFF", admin: adminApi ? "on" : "off" },
  );
  return app;
}

/**
 * Startup checks on the pool's login (SPEC-009 §3): with the admin API on it
 * must be able to become fsm_admin, or every admin request would fail at its
 * first query; with auth on, a login that inherits privileges (rather than an
 * fsm_authenticator-style NOINHERIT one) works but holds rights of its own.
 */
async function checkPoolLogin(
  pool: Pool,
  { auth, adminApi }: { auth: boolean; adminApi: boolean },
): Promise<void> {
  if (!auth) return;
  const { rows: [login] } = await pool.query<{
    login: string;
    inherits: boolean;
    can_admin: boolean;
  }>(
    `SELECT session_user AS login,
            r.rolinherit AS inherits,
            pg_has_role(session_user, 'fsm_admin', 'MEMBER') AS can_admin
     FROM pg_roles r WHERE r.rolname = session_user`,
  );
  if (adminApi && !login.can_admin) {
    throw new Error(
      `createApp: the admin API is on but the API's database login ${login.login} can't act as fsm_admin. Run: GRANT fsm_admin TO ${login.login};`,
    );
  }
  if (login.inherits) {
    logger.warn(
      "The API's database login {login} inherits privileges. Requests still run under the API key's role, but in production log in as fsm_authenticator (NOINHERIT), so the process holds no rights of its own.",
      { login: login.login },
    );
  }
}
