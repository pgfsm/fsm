import { createRouter } from "../../lib/create-app.ts";

import * as handlers from "./fsmworker.handlers.ts";
import * as routes from "./fsmworker.routes.ts";

const router = createRouter()
  .openapi(routes.list, handlers.list)
  .openapi(routes.create, handlers.create);

export default router;
