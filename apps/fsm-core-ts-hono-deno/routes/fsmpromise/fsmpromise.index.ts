import { createRouter } from "../../lib/create-app.ts";

import * as handlers from "./fsmpromise.handlers.ts";
import * as routes from "./fsmpromise.routes.ts";

const router = createRouter()
  .openapi(routes.list, handlers.list)
  .openapi(routes.resume, handlers.resume)
  .openapi(routes.stop, handlers.stop);

export default router;
