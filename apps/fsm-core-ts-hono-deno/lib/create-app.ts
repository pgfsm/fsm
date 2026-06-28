import type { Schema } from "hono";
import { cors } from "hono/cors";
import { getLogger } from "@logtape/logtape";
import { bootstrapFsmModules, pgListenerForWorkerStopEvent } from "@pgfsm/worker";
import { activeWorkers } from "../routes/fsm/fsm.handlers.ts";

export type { FsmFolderConfig, FsmStartupConfig } from "./types.ts";

import { OpenAPIHono } from "@hono/zod-openapi";
import { requestId } from "hono/request-id";
import {
  notFound,
  onError,
  serveEmojiFavicon,
} from "stoker/middlewares/index.ts";
import { defaultHook } from "stoker/openapi/index.ts";

import configureOpenAPI from "./configure-open-api.ts";

// import { pinoLogger } from "./../middlewares/pino-logger.ts";
import { logtapeLogger } from "./../middlewares/logtape-logger.ts";
import { otelTrace } from "./../middlewares/otel-trace.ts";

import type { AppBindings, AppOpenAPI, FsmStartupConfig, VerifiedFsmModule } from "./types.ts";
import { supabaseMiddleware } from "../middlewares/supabase.ts";
import env from "../env.ts";

import index from "../routes/index.route.ts";
import fsm from "../routes/fsm/fsm.index.ts";
import fsmpromise from "../routes/fsmpromise/fsmpromise.index.ts";

const logger = getLogger(["@pgfsm/api", "app"]);

export function createRouter() {
  return new OpenAPIHono<AppBindings>({
    strict: false,
    defaultHook,
  });
}

export default async function createApp(
  basePath = "",
  fsmConfig?: FsmStartupConfig,
) {
  const { pool, verifiedFsmModules } = await bootstrapFsmModules(
    { connectionString: env.DATABASE_URL },
    fsmConfig,
  );
  await pgListenerForWorkerStopEvent(pool, (queueName) => {
    if (activeWorkers[queueName]) {
      activeWorkers[queueName].lock = false;
      activeWorkers[queueName].controller.abort();
    }
  });

  pool.on("connect", () => {
    logger.debug("Database pool: new connection established");
  });
  pool.on("acquire", () => {
    // pool acquire events are too noisy for info; enable at debug if needed
  });
  pool.on("error", (err) => {
    logger.error("Database pool error: {error}", { error: err });
  });

  const app = createRouter();

  const otelEnabled = env.OTEL_DENO === "true" && !!env.OTEL_EXPORTER_OTLP_ENDPOINT;

  // app.use(requestId()).use(serveEmojiFavicon("📝")).use(pinoLogger());
  app.use(requestId()).use(serveEmojiFavicon("📝")).use(logtapeLogger());
  if (otelEnabled) app.use(otelTrace());
  app.use("*", async (c, next) => {
    const corsMiddlewareHandler = cors({
      origin: env.CORS_ORIGIN,
    });
    return corsMiddlewareHandler(c, next);
  });

  app.use("*", (c, next) => {
    c.set("fsmConfig", fsmConfig);
    c.set("verifiedFsmModules", verifiedFsmModules);
    return next();
  });

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

  app.notFound(notFound);
  app.onError(onError);

  const routes = [
    index,
    fsm,
    fsmpromise,
  ] as const;

  routes.forEach((route) => {
    app.route("/", route);
  });

  configureOpenAPI(app, basePath);

  return app;
}
