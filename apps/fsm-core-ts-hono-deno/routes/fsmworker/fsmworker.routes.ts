import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes.ts";
import {
  jsonContent,
  jsonContentRequired,
} from "stoker/openapi/helpers/index.ts";
import {
  createErrorSchema,
  IdParamsSchema,
} from "stoker/openapi/schemas/index.ts";

// import { insertfsmworkerSchema, patchfsmworkerSchema, selectfsmworkerSchema } from "./../../db/schema.ts";
import { notFoundSchema } from "../../lib/constants.ts";

const tags = ["fsmworker"];

export const list = createRoute({
  path: "/fsmworker",
  method: "get",
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({}),
      "The list of fsmworker",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      z.object({
        error: z.string(),
      }),
      "Failed to retrieve user",
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
          "The name of the queue to start the fsmworker for",
        ),
      }),
      "The fsmworker configuration",
    ),
  },
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({}),
      "The fsmworker started successfully",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      z.object({}),
      "The validation error(s)",
    ),
  },
});

export type ListRoute = typeof list;
export type CreateRoute = typeof create;
