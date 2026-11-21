import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes.ts";
import { jsonContent } from "stoker/openapi/helpers/index.ts";

import { createRouter } from "./../lib/create-router.ts";
import { type LicenseNotice, licenseNotice } from "./../lib/license.ts";

const IndexSchema = z.object({
  message: z.string().openapi({ example: "pgfsm API" }),
  license: z.string().openapi({ example: "AGPL-3.0-only" }),
  source: z.string().url().openapi({ example: "https://github.com/pgfsm/fsm" }),
});

/**
 * GET /: the API index, unauthenticated, and the readiness probe. It also
 * reports the API's licence and where its source is (SPEC-017, AGPL-3.0 §13).
 */
export function createIndexRouter(notice: LicenseNotice = licenseNotice()) {
  return createRouter()
    .openapi(
      createRoute({
        tags: ["Index"],
        method: "get",
        path: "/",
        responses: {
          [HttpStatusCodes.OK]: jsonContent(
            IndexSchema,
            "pgfsm API index (unauthenticated; also the readiness probe), with the API's licence and source URL",
          ),
        },
      }),
      (c) => {
        return c.json({
          message: "pgfsm API",
          license: notice.license,
          source: notice.source,
        }, HttpStatusCodes.OK);
      },
    );
}
