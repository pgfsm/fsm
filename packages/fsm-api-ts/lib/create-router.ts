import { OpenAPIHono } from "@hono/zod-openapi";
import { defaultHook } from "stoker/openapi/index.ts";

import type { AppBindings } from "./types.ts";

// Kept apart from create-app.ts (which reads env.ts at import time) so route
// modules can be imported, and tested, without the API's environment.
export function createRouter() {
  return new OpenAPIHono<AppBindings>({
    strict: false,
    defaultHook,
  });
}
