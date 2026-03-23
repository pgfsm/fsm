import type { Schema } from "hono";
import { cors } from "hono/cors";
import { Pool } from "pg";
import {
  loadAndVerifyFsmFromFolders,
  loadAndVerifyPromiseFromFolders,
} from "../../../packages/fsm-compiler-ts/src/index.ts";

export type FsmFolderConfig = {
  folderPath: string;
  skipDirs?: string[];
};

export type FsmStartupConfig = {
  sharedPromise?: FsmFolderConfig;
  sharedFsm?: FsmFolderConfig;
  fsm?: FsmFolderConfig;
};

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

export default function createApp(
  pool?: Pool,
  basePath = "",
  fsmConfig?: FsmStartupConfig,
) {
  const app = createRouter();

  pool.on("connect", () => {
    console.log("Database on connect event");
  });
  pool.on("acquire", () => {
    console.log("Database on acquired event");
  });
  pool.on("error", (err) => {
    console.error("Database error event:", err);
  });

  if (fsmConfig && pool) {
    pool.connect().then(async (client) => {
      client.release();
      const deps = { db: pool };

      const outputSharedPromise = fsmConfig.sharedPromise
        ? await loadAndVerifyPromiseFromFolders(
            deps,
            fsmConfig.sharedPromise.folderPath,
            "sharedPromise",
            fsmConfig.sharedPromise.skipDirs ?? [],
            [],
          )
        : [];

      const outputSharedFsm = fsmConfig.sharedFsm
        ? await loadAndVerifyFsmFromFolders(
            deps,
            fsmConfig.sharedFsm.folderPath,
            "sharedFsm",
            fsmConfig.sharedFsm.skipDirs ?? [],
            outputSharedPromise,
          )
        : [];

      if (fsmConfig.fsm) {
        await loadAndVerifyFsmFromFolders(
          deps,
          fsmConfig.fsm.folderPath,
          "fsm",
          fsmConfig.fsm.skipDirs ?? [],
          [...outputSharedPromise, ...outputSharedFsm],
        );
      }
    }).catch((err) => {
      console.error("Pool connect error during FSM startup:", err);
    });
  }

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
