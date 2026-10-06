import { createRouter } from "../../lib/create-router.ts";

import * as handlers from "./admin.handlers.ts";
import * as routes from "./admin.routes.ts";

const router = createRouter()
  .openapi(routes.loadFsm, handlers.loadFsm)
  .openapi(routes.listKeys, handlers.listKeys)
  .openapi(routes.createKey, handlers.createKey)
  .openapi(routes.revokeKey, handlers.revokeKey);

export default router;
