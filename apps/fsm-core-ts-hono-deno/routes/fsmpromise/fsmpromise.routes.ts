import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes.ts";
import {
  jsonContent,
  jsonContentRequired,
} from "stoker/openapi/helpers/index.ts";

import { notFoundSchema } from "../../lib/constants.ts";

const tags = ["fsmpromise"];

export const list = createRoute({
  path: "/fsmpromise",
  method: "get",
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({}),
      "The list of active promise workers",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      z.object({ error: z.string() }),
      "Error",
    ),
  },
});

export const resume = createRoute({
  path: "/fsmpromise/resume",
  method: "post",
  request: {
    body: jsonContentRequired(
      z.object({
        promise_name: z.string().describe(
          "The queue name for the promise worker",
        ),
        promise_type: z.string().describe("The actor type name to invoke"),
        promise_version: z.string().describe("The version of the promise"),
        fsm_name: z.string().describe(
          "Parent FSM name (for verifiedModule lookup)",
        ),
        fsm_version: z.string().describe(
          "Parent FSM version (for verifiedModule lookup)",
        ),
      }),
      "Promise worker configuration",
    ),
  },
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({}),
      "Promise worker resumed successfully",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      z.object({ error: z.string() }),
      "Error",
    ),
  },
});

export const createAndStart = createRoute({
  path: "/fsmpromise/create-and-start",
  method: "post",
  request: {
    body: jsonContentRequired(
      z.object({
        queue_name: z.string().describe("The PGMQ queue name to create"),
        fsm_name: z.string().describe(
          "Parent FSM name (for verifiedModule lookup)",
        ),
        promise_type: z.string().describe("The actor type name to invoke"),
        fsm_version: z.string().describe("Parent FSM version"),
      }),
      "Promise worker creation config",
    ),
  },
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({}),
      "Promise queue created and worker started",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      z.object({ error: z.string() }),
      "Error",
    ),
  },
});

export const stop = createRoute({
  path: "/fsmpromise/stop",
  method: "post",
  request: {
    body: jsonContentRequired(
      z.object({
        queue: z.string().describe("The promise queue name to stop"),
      }),
      "The queue to stop",
    ),
  },
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({}),
      "Worker stopped successfully",
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      z.object({ error: z.string() }),
      "No active promise worker for the given queue",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      z.object({ error: z.string() }),
      "Error",
    ),
  },
});

export type ListRoute = typeof list;
export type ResumeRoute = typeof resume;
export type CreateAndStartRoute = typeof createAndStart;
export type StopRoute = typeof stop;
