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

// import { insertfsmSchema, patchfsmSchema, selectfsmSchema } from "./../../db/schema.ts";
import { notFoundSchema } from "../../lib/constants.ts";

const tags = ["fsm"];

export const list = createRoute({
  path: "/fsm",
  method: "get",
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        data: z.array(z.object({
          id: z.string(),
          fsm_name: z.string().nullable(),
          fsm_version: z.string().nullable(),
          fsm_instance_status: z.string().nullable(),
        })),
      }),
      "List of FSM instances",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      z.object({ error: z.string() }),
      "Error",
    ),
  },
});

export const create = createRoute({
  path: "/fsm",
  method: "post",
  request: {
    body: jsonContentRequired(
      z.object({
        fsm_name: z.string().describe("The FSM definition name"),
        fsm_version: z.string().describe("The FSM version"),
        fsm_context: z.record(z.unknown()).optional().describe(
          "Initial FSM context (defaults to {})",
        ),
      }),
      "The fsm configuration",
    ),
  },
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({}),
      "The fsm started successfully",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      z.object({}),
      "The validation error(s)",
    ),
  },
});

export const send = createRoute({
  path: "/fsm/send",
  method: "post",
  request: {
    body: jsonContentRequired(
      z.object({
        fsm_instance_id: z.string().describe("input fsm_instance_id"),
        event_data: z.object({
          type: z.string(),
        }).passthrough(),
      }),
      "The fsm configuration",
    ),
  },
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({}),
      "The fsm started successfully",
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      notFoundSchema,
      "FSM instance not found",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      z.object({}),
      "The validation error(s)",
    ),
  },
});

export const currentActive = createRoute({
  path: "/fsm/currentActive",
  method: "get",
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({ data: z.record(z.boolean()) }),
      "Active FSM worker locks",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      z.object({ error: z.string() }),
      "Error",
    ),
  },
});

export const start = createRoute({
  path: "/fsm/start",
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

export const stop = createRoute({
  path: "/fsm/stop",
  method: "post",
  request: {
    body: jsonContentRequired(
      z.object({
        queue: z.string().describe("The FSM instance ID (queue name) to stop"),
      }),
      "The queue to stop",
    ),
  },
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({}), "Worker stopped successfully"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      z.object({ error: z.string() }),
      "No active worker for the given queue",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      z.object({ error: z.string() }),
      "Error",
    ),
  },
});

export type ListRoute = typeof list;
export type CreateRoute = typeof create;
export type SendRoute = typeof send;
export type CurrentActiveRoute = typeof currentActive;
export type StartRoute = typeof start;
export type StopRoute = typeof stop;
