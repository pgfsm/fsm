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

// import { insertpromiseSchema, patchpromiseSchema, selectpromiseSchema } from "./../../db/schema.ts";
import { notFoundSchema } from "../../lib/constants.ts";

const tags = ["fsmpromise"];

export const list = createRoute({
  path: "/fsmpromise",
  method: "get",
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({}),
      "The list of promise",
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
  path: "/fsmpromise",
  method: "post",
  request: {
    body: jsonContentRequired(
      z.object({
        promise_name: z.string().describe("The name of the promise to start"),
        promise_version: z.string().describe(
          "The version of the promise to start",
        ),
      }),
      "The promise configuration",
    ),
  },
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({}),
      "The promise started successfully",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      z.object({}),
      "The validation error(s)",
    ),
  },
});

export type ListRoute = typeof list;
export type CreateRoute = typeof create;
