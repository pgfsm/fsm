import type { OpenAPIHono, RouteConfig, RouteHandler } from "@hono/zod-openapi";
import type { Schema } from "hono";
// @ts-types="@types/pg"
import type { Pool } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@pgfsm/db/database.types";
// import type { PinoLogger } from "hono-pino"; // replaced by LogTape — see middlewares/pino-logger.ts
// @logtape/hono uses withContext() instead of injecting into c.var, so there is
// no per-request logger variable here. Use getLogger() at module level in handlers.

import type { ApiKeyRole } from "@pgfsm/db";

export interface AppBindings {
  Bindings: {
    MY_DB: unknown;
  };
  Variables: {
    db: Pool;
    supabase: SupabaseClient<Database>;
    /** The API key's role; unset when auth is off (--no-auth). */
    role: ApiKeyRole | undefined;
  };
}

// eslint-disable-next-line ts/no-empty-object-type
export type AppOpenAPI<S extends Schema = Record<PropertyKey, never>> =
  OpenAPIHono<AppBindings, S>;

export type AppRouteHandler<R extends RouteConfig> = RouteHandler<
  R,
  AppBindings
>;
