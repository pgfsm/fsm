import { createRouter } from "../../lib/create-router.ts";

import * as handlers from "./definitions.handlers.ts";
import * as routes from "./definitions.routes.ts";

const router = createRouter()
  .openapi(routes.list, handlers.list)
  .openapi(routes.versions, handlers.versions)
  .openapi(routes.getOne, handlers.getOne);

export default router;
