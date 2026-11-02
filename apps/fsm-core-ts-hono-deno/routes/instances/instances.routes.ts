import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes.ts";
import {
  jsonContent,
  jsonContentRequired,
} from "stoker/openapi/helpers/index.ts";
import { IdUUIDParamsSchema } from "stoker/openapi/schemas/index.ts";

import { notFoundSchema } from "../../lib/constants.ts";

// FSM instances (#675): one resource, its id in the path, actions as
// sub-resources. Every route needs an operator (or admin) key.
const tags = ["instances"];

const errorSchema = z.object({ error: z.string() });
const instanceNotFound = jsonContent(notFoundSchema, "No such FSM instance");

export const list = createRoute({
  path: "/instances",
  method: "get",
  request: {
    // Filtered and limited in the database (#661).
    query: z.object({
      fsm_name: z.string().optional().describe("Only this FSM"),
      fsm_version: z.string().optional().describe("Only this version"),
      status: z.enum(["active", "done", "error", "stopped"]).optional()
        .describe("Only instances with this status"),
      limit: z.coerce.number().int().min(1).max(1000).default(50).describe(
        "At most this many, newest first (default 50, max 1000)",
      ),
    }),
  },
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        data: z.array(
          z.object({
            id: z.string(),
            fsm_name: z.string().nullable(),
            fsm_version: z.string().nullable(),
            fsm_instance_status: z.unknown(),
          }).passthrough(),
        ),
      }),
      "FSM instances, newest first",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(errorSchema, "Error"),
  },
});

export const getOne = createRoute({
  path: "/instances/{id}",
  method: "get",
  request: { params: IdUUIDParamsSchema },
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        data: z.object({
          fsm_instance_row: z.record(z.unknown()),
          resolved_state_value: z.unknown(),
        }),
      }),
      "The FSM instance and its resolved state",
    ),
    [HttpStatusCodes.NOT_FOUND]: instanceNotFound,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(errorSchema, "Error"),
  },
});

export const create = createRoute({
  path: "/instances",
  method: "post",
  request: {
    body: jsonContentRequired(
      z.object({
        fsm_name: z.string().min(1).describe("The FSM definition name"),
        fsm_version: z.string().min(1).describe("The FSM version"),
        input: z.record(z.unknown()).optional().describe(
          "Initial context, merged over the definition's static context (XState's input; defaults to {})",
        ),
      }),
      "The FSM to start",
    ),
  },
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({ data: z.record(z.unknown()) }),
      "The created instance, enqueued for scheduling",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(errorSchema, "Error"),
  },
});

export const sendEvent = createRoute({
  path: "/instances/{id}/events",
  method: "post",
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(
      z.object({ type: z.string().min(1) }).passthrough(),
      "The event: its type and any payload fields",
    ),
  },
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({ data: z.any() }),
      "The event was queued for the instance",
    ),
    [HttpStatusCodes.NOT_FOUND]: instanceNotFound,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(errorSchema, "Error"),
  },
});

export const resume = createRoute({
  path: "/instances/{id}/resume",
  method: "post",
  request: { params: IdUUIDParamsSchema },
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({ data: z.record(z.unknown()) }),
      "The instance was re-enqueued for scheduling",
    ),
    [HttpStatusCodes.NOT_FOUND]: instanceNotFound,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(errorSchema, "Error"),
  },
});

export const stop = createRoute({
  path: "/instances/{id}/stop",
  method: "post",
  request: { params: IdUUIDParamsSchema },
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({}),
      "The instance's worker was told to stop",
    ),
    [HttpStatusCodes.NOT_FOUND]: instanceNotFound,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(errorSchema, "Error"),
  },
});

export type ListRoute = typeof list;
export type GetOneRoute = typeof getOne;
export type CreateRoute = typeof create;
export type SendEventRoute = typeof sendEvent;
export type ResumeRoute = typeof resume;
export type StopRoute = typeof stop;
