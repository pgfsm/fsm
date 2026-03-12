import type { Schema } from "hono";
import { cors } from "hono/cors";
import { Pool } from "pg";

import { OpenAPIHono } from "@hono/zod-openapi";
import { requestId } from "hono/request-id";
import {
  notFound,
  onError,
  serveEmojiFavicon,
} from "stoker/middlewares/index.ts";
import { defaultHook } from "stoker/openapi/index.ts";

import configureOpenAPI from "./configure-open-api.ts";

import { pinoLogger } from "./../middlewares/pino-logger.ts";

import type { AppBindings, AppOpenAPI } from "./types.ts";
import { supabaseMiddleware } from "../middlewares/supabase.ts";
import env from "../env.ts";

import index from "../routes/index.route.ts";
import fsm from "../routes/fsm/fsm.index.ts";
import fsmworker from "../routes/fsmworker/fsmworker.index.ts";
import fsmpromise from "../routes/fsmpromise/fsmpromise.index.ts";

export function createRouter() {
  return new OpenAPIHono<AppBindings>({
    strict: false,
    defaultHook,
  });
}

export default function createApp(pool?: Pool,basePath = "") {
  const app = createRouter();

  pool.on("connect", () => {
    console.log("Database on connect event");
    
  });
  pool.on("acquire", () => {
    console.log("Database on acquired event");
    // console.log("number of clients in the pool:", pool.totalCount);
    // console.log("number of idle clients in the pool:", pool.idleCount);
    // console.log("number of waiting requests in the pool:", pool.waitingCount);
  });
  pool.on("error", (err) => {
    console.error("Database error event:", err);
  });

  // pool.connect().then(() => {
  //   console.log("Database connection established");
  //   app.set("db",pool)
     
  // }).catch((err) => {
  //   console.error("Database connection error:", err);
  // });

  app.use(requestId()).use(serveEmojiFavicon("📝")).use(pinoLogger());
  app.use("*", async (c, next) => {
    const corsMiddlewareHandler = cors({
      origin: env.CORS_ORIGIN,
    });
    return corsMiddlewareHandler(c, next);
  });

  if (env.DB_TYPE === "supabase") {
    app.use("*", supabaseMiddleware());
  } else if (env.DB_TYPE === "postgres") {
    // Attach the db connection to the context for all routes
    if (pool) {
      app.use("*", (c, next) => {
        c.set("db", pool);
        return next();
      });
    }
  } else if (env.DB_TYPE === "supabase_and_postgres") {
    app.use("*", supabaseMiddleware());
    // Attach the db connection to the context for all routes
    if (pool) {
      app.use("*", (c, next) => {
        c.set("db", pool);
        return next();
      });
    }
  }

  app.notFound(notFound);
  app.onError(onError);

  const routes = [
    index,
    fsm,
    fsmworker,
    fsmpromise,
  ] as const;

  routes.forEach((route) => {
    app.route("/", route);
  });

  configureOpenAPI(app,basePath);

  return app;
}
