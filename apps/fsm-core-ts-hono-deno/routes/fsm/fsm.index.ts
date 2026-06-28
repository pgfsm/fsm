import { createRouter } from "../../lib/create-app.ts";

import * as handlers from "./fsm.handlers.ts";
import * as routes from "./fsm.routes.ts";

const router = createRouter()
  .openapi(routes.list, handlers.list)
  .openapi(routes.getOne, handlers.getOne)
  .openapi(routes.create, handlers.createAndStart)
  .openapi(routes.send, handlers.send)
  .openapi(routes.currentActive, handlers.currentActive)
  .openapi(routes.resume, handlers.resumeWithWorker)
  .openapi(routes.stop, handlers.stop)
  .openapi(routes.createAndDispatch, handlers.createAndDispatch)
  .openapi(routes.resumeViaDispatch, handlers.resumeViaDispatch);
// .openapi(routes.patch, handlers.patch)
// .openapi(routes.remove, handlers.remove);

export default router;
