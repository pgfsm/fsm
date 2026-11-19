import { createRouter } from "../../lib/create-router.ts";

import * as handlers from "./instances.handlers.ts";
import * as routes from "./instances.routes.ts";

const router = createRouter()
  .openapi(routes.list, handlers.list)
  .openapi(routes.getOne, handlers.getOne)
  .openapi(routes.create, handlers.create)
  .openapi(routes.sendEvent, handlers.sendEvent)
  .openapi(routes.resume, handlers.resume)
  .openapi(routes.stop, handlers.stop);

export default router;
