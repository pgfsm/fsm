import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes.ts";
import { jsonContent } from "stoker/openapi/helpers/index.ts";
import { createMessageObjectSchema } from "stoker/openapi/schemas/index.ts";

import { createRouter } from "./../lib/create-router.ts";

const router = createRouter()
  .openapi(
    createRoute({
      tags: ["Index"],
      method: "get",
      path: "/",
      responses: {
        [HttpStatusCodes.OK]: jsonContent(
          createMessageObjectSchema("pgfsm API"),
          "pgfsm API index (unauthenticated; also the readiness probe)",
        ),
      },
    }),
    (c) => {
      return c.json({
        message: "pgfsm API",
      }, HttpStatusCodes.OK);
    },
  );

export default router;
