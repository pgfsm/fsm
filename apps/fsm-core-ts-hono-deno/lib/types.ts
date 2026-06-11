import type { OpenAPIHono, RouteConfig, RouteHandler } from "@hono/zod-openapi";
import type { Schema } from "hono";
import type { PinoLogger } from "hono-pino";

export type { FsmFolderConfig, FsmStartupConfig, VerifiedFsmModule } from "@pgfsm/worker";
import type { FsmStartupConfig, VerifiedFsmModule } from "@pgfsm/worker";

export interface AppBindings {
  Bindings: {
    MY_DB: any;
  };
  Variables: {
    db: any;
    supabase: any;
    logger: PinoLogger;
    fsmConfig: FsmStartupConfig | undefined;
    verifiedFsmModules: VerifiedFsmModule[];
  };
}

// eslint-disable-next-line ts/no-empty-object-type
export type AppOpenAPI<S extends Schema = {}> = OpenAPIHono<AppBindings, S>;

export type AppRouteHandler<R extends RouteConfig> = RouteHandler<
  R,
  AppBindings
>;
