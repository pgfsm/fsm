import type { OpenAPIHono, RouteConfig, RouteHandler } from "@hono/zod-openapi";
import type { Schema } from "hono";
import type { Pool } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@pgfsm/db/database.types";
// import type { PinoLogger } from "hono-pino"; // replaced by LogTape — see middlewares/pino-logger.ts
// @logtape/hono uses withContext() instead of injecting into c.var, so there is
// no per-request logger variable here. Use getLogger() at module level in handlers.

export type { FsmFolderConfig, FsmStartupConfig } from "@pgfsm/worker";
import type { FsmStartupConfig } from "@pgfsm/worker";
import type { FsmPluginValidationResult } from "@pgfsm/compiler";

export interface AppBindings {
  Bindings: {
    MY_DB: unknown;
  };
  Variables: {
    db: Pool;
    supabase: SupabaseClient<Database>;
    fsmConfig: FsmStartupConfig | undefined;
    verifiedFsmModules: FsmPluginValidationResult[];
  };
}

// eslint-disable-next-line ts/no-empty-object-type
export type AppOpenAPI<S extends Schema = Record<PropertyKey, never>> =
  OpenAPIHono<AppBindings, S>;

export type AppRouteHandler<R extends RouteConfig> = RouteHandler<
  R,
  AppBindings
>;
