import type { Schema } from "hono";
import { cors } from "hono/cors";
import { Pool } from "pg";
import {
  loadAndValidateFsmFromFolders,
  loadAndValidatePromiseFromFolders,
} from "@fsm/compiler";
import { createAndStartPromiseWorker } from "@fsm/worker";

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

import { pinoLogger } from "./../middlewares/pino-logger.ts";

import type { AppBindings, AppOpenAPI, FsmStartupConfig } from "./types.ts";
import { supabaseMiddleware } from "../middlewares/supabase.ts";
import env from "../env.ts";

import index from "../routes/index.route.ts";
import fsm from "../routes/fsm/fsm.index.ts";
import fsmpromise from "../routes/fsmpromise/fsmpromise.index.ts";

export function createRouter() {
  return new OpenAPIHono<AppBindings>({
    strict: false,
    defaultHook,
  });
}

export default async function createApp(
  pool?: Pool,
  basePath = "",
  fsmConfig?: FsmStartupConfig,
) {
  

  pool.on("connect", () => {
    console.log("Database on connect event");
  });
  pool.on("acquire", () => {
    // console.log("Database on acquired event");
  });
  pool.on("error", (err) => {
    console.error("Database error event:", err);
  });

  let verifiedFsmModules: any[] = [];
  let verifiedPromiseModules: any[] = [];
  if (fsmConfig && pool) {
    const client = await pool.connect();
    client.release();
    const deps = { db: pool };

    const outputSharedPromise = fsmConfig.sharedPromise
      ? await loadAndValidatePromiseFromFolders(
          deps,
          fsmConfig.sharedPromise.folderPath,
          "sharedPromise",
          fsmConfig.sharedPromise.skipDirs ?? [],
          [],
        )
      : [];
    const verifiedSharedPromise = outputSharedPromise.filter((m) => m.isFsmModuleVerified === true)  

    const outputSharedFsm = fsmConfig.sharedFsm
      ? await loadAndValidateFsmFromFolders(
          deps,
          fsmConfig.sharedFsm.folderPath,
          "sharedFsm",
          fsmConfig.sharedFsm.skipDirs ?? [],
          outputSharedPromise,
        )
      : [];
    const verifiedSharedFsm = outputSharedFsm.filter((m) => m.isFsmModuleVerified === true)  
    
    
    const outputFsm = fsmConfig.fsm
      ? await loadAndValidateFsmFromFolders(
          deps,
          fsmConfig.fsm.folderPath,
          "fsm",
          fsmConfig.fsm.skipDirs ?? [],
          [...outputSharedPromise, ...outputSharedFsm],
        )
      : [];
    const verifiedFsm = outputFsm.filter((m) => m.isFsmModuleVerified === true);  

    verifiedFsmModules = [
      ...verifiedSharedPromise,
      ...verifiedSharedFsm,
      ...verifiedFsm,
    ]
    .map((m) => ({ fsmName: m.fsmName, fsmVersion: m.fsmVersion, fsmType: m.fsmType, fsmAbsFolderPath: m.fsmAbsFolderPath, fsmRelativeFolderPath: m.fsmRelativeFolderPath, fsmParentDirName : m.fsmParentDirName, fsmParentAbsFolderPath: m.fsmParentAbsFolderPath, fsmParentRelativeFolderPath: m.fsmParentRelativeFolderPath, internalActors: m.internalActors }));

    // Merge internalActors from verifiedSharedFsm and verifiedFsm into one flat array,
    // each with its own AbortController for graceful shutdown
    const allInternalActors = [
      ...verifiedSharedFsm,
      ...verifiedFsm,
    ].flatMap((fsm) =>
      (fsm.internalActors ?? []).map((actor) => ({
        src: actor.src,
        fsmName: actor.fsmName,
        fsmType: actor.fsmType,
        fsmVersion: actor.fsmVersion,
        parentFsmName: fsm.fsmName,
        parentFsmVersion: fsm.fsmVersion,
        fsmAbsFolderPath: fsm.fsmAbsFolderPath as string,
        controller: new AbortController(),
      }))
    );

    const promiseDeps = { db: pool, useSupabase: false };

    for (const actor of allInternalActors) {
      try {
        await createAndStartPromiseWorker(
          promiseDeps,
          `${actor.parentFsmName}_${actor.parentFsmVersion}_${actor.src}`,
          actor.src,
          actor.fsmType,
          actor.fsmVersion,
          { fsmAbsFolderPath: actor.fsmAbsFolderPath },
          actor.controller.signal,
        );
        console.log(`✅ Promise worker started for actor: ${actor.src}`);
      } catch (err) {
        console.warn(`⚠️ Could not start promise worker for "${actor.src}":`, err);
      }
    }

  }

  const app = createRouter();

  app.use(requestId()).use(serveEmojiFavicon("📝")).use(pinoLogger());
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
    if (pool) {
      app.use("*", (c, next) => {
        c.set("db", pool);
        return next();
      });
    }
  } else if (env.DB_TYPE === "supabase_and_postgres") {
    app.use("*", supabaseMiddleware());
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
    fsmpromise,
  ] as const;

  routes.forEach((route) => {
    app.route("/", route);
  });

  configureOpenAPI(app, basePath);

  return app;
}
