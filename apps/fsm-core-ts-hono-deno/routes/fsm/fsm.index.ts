import { createRouter } from "../../lib/create-app.ts";

import * as handlers from "./fsm.handlers.ts";
import * as routes from "./fsm.routes.ts";

const router = createRouter()
  .openapi(routes.list, handlers.list)
  .openapi(routes.create, handlers.create)
  .openapi(routes.send, handlers.send);
// .openapi(routes.patch, handlers.patch)
// .openapi(routes.remove, handlers.remove);

export default router;
