import { createRouter } from "../../lib/create-router.ts";

import * as handlers from "./fsm.handlers.ts";
import * as dispatch from "./fsm.handlers.dispatch.ts";
import * as routes from "./fsm.routes.ts";

const router = createRouter()
  .openapi(routes.list, handlers.list)
  .openapi(routes.getOne, handlers.getOne)
  .openapi(routes.create, handlers.create)
  .openapi(routes.send, handlers.send)
  .openapi(routes.stop, handlers.stop)
  .openapi(routes.createAndDispatch, dispatch.createAndDispatch)
  .openapi(routes.resumeViaDispatch, dispatch.resumeViaDispatch);

export default router;
