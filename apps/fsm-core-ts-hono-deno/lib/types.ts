import type { OpenAPIHono, RouteConfig, RouteHandler } from "@hono/zod-openapi";
import type { Schema } from "hono";
import type { PinoLogger } from "hono-pino";

export type FsmFolderConfig = {
  folderPath: string;
  skipDirs?: string[];
};

export type FsmStartupConfig = {
  sharedPromise?: FsmFolderConfig;
  sharedFsm?: FsmFolderConfig;
  fsm?: FsmFolderConfig;
};

export interface AppBindings {
  Bindings: {
    MY_DB: any;
  };
  Variables: {
    db: any;
    supabase: any;
    logger: PinoLogger;
    fsmConfig: FsmStartupConfig | undefined;
    verifiedModules: {
      fsmName: string;
      fsmVersion: string;
      fsmType: string;
      fsmAbsFolderPath: string;
      fsmRelativeFolderPath: string;
      fsmParentAbsFolderPath: string;
      fsmParentRelativeFolderPath: string;
    }[];
  };
}

// eslint-disable-next-line ts/no-empty-object-type
export type AppOpenAPI<S extends Schema = {}> = OpenAPIHono<AppBindings, S>;

export type AppRouteHandler<R extends RouteConfig> = RouteHandler<
  R,
  AppBindings
>;
