import { createRouter } from "../../lib/create-app.ts";

import * as handlers from "./fsm.handlers.ts";
import * as inprocess from "./fsm.handlers.inprocess.ts";
import * as dispatch from "./fsm.handlers.dispatch.ts";
import * as routes from "./fsm.routes.ts";

const router = createRouter()
  .openapi(routes.list, handlers.list)
  .openapi(routes.getOne, handlers.getOne)
  .openapi(routes.send, handlers.send)
  .openapi(routes.stop, handlers.stop)
  .openapi(routes.currentActive, inprocess.currentActive)
  .openapi(routes.create, inprocess.createAndStart)
  .openapi(routes.resume, inprocess.resumeWithWorker)
  .openapi(routes.createAndDispatch, dispatch.createAndDispatch)
  .openapi(routes.resumeViaDispatch, dispatch.resumeViaDispatch);

export default router;
