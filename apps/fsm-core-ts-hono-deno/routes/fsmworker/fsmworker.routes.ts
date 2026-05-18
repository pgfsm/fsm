import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes.ts";
import {
  jsonContent,
  jsonContentRequired,
} from "stoker/openapi/helpers/index.ts";

import { notFoundSchema } from "../../lib/constants.ts";

const tags = ["fsmworker"];

export const list = createRoute({
  path: "/fsmworker",
  method: "get",
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({}),
      "Active FSM worker locks",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      z.object({ error: z.string() }),
      "Error",
    ),
  },
});

export const create = createRoute({
  path: "/fsmworker",
  method: "post",
  request: {
    body: jsonContentRequired(
      z.object({
        queue: z.string().describe(
          "The FSM instance ID (queue name) to start the worker for",
        ),
      }),
      "The fsmworker configuration",
    ),
  },
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({}),
      "Worker started successfully",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      z.object({ error: z.string() }),
      "Error",
    ),
  },
});

export type ListRoute = typeof list;
export type CreateRoute = typeof create;
