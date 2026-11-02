import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes.ts";
import { jsonContent } from "stoker/openapi/helpers/index.ts";
import { notFoundSchema } from "../../lib/constants.ts";

// Loaded FSM definitions (fsm_core.fsm_json), read-only, for `pgfsmctl fsm
// list|get` with an operator key (#661). Loading them is POST
// /admin/fsm/load, admin only.
const tags = ["definitions"];

const summary = z.object({
  fsm_name: z.string(),
  fsm_version: z.string(),
  fsm_type: z.string().nullable(),
  fsm_json_sha256: z.string(),
});

export const list = createRoute({
  path: "/definitions",
  method: "get",
  request: {
    query: z.object({
      fsm_name: z.string().optional().describe("Only this FSM"),
      fsm_version: z.string().optional().describe("Only this version"),
    }),
  },
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({ data: z.array(summary) }),
      "Loaded definitions, by name then version",
    ),
  },
});

export const versions = createRoute({
  path: "/definitions/{fsmName}",
  method: "get",
  request: { params: z.object({ fsmName: z.string() }) },
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({ data: z.array(summary) }),
      "The FSM's loaded versions",
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      notFoundSchema,
      "No version of that FSM is loaded",
    ),
  },
});

export const getOne = createRoute({
  path: "/definitions/{fsmName}/versions/{fsmVersion}",
  method: "get",
  request: {
    params: z.object({ fsmName: z.string(), fsmVersion: z.string() }),
  },
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        data: z.object({
          fsm_name: z.string(),
          fsm_version: z.string(),
          fsm_json: z.unknown(),
        }),
      }),
      "One loaded definition and its fsm.json",
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      notFoundSchema,
      "That FSM version isn't loaded",
    ),
  },
});

export type ListRoute = typeof list;
export type VersionsRoute = typeof versions;
export type GetOneRoute = typeof getOne;
