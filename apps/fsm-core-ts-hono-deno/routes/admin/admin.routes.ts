import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes.ts";
import {
  jsonContent,
  jsonContentRequired,
} from "stoker/openapi/helpers/index.ts";

// Admin API (SPEC-009 §3): only mounted with --enable-admin-api, and every
// route needs an admin key.

const tags = ["admin"];

const messageSchema = z.object({ message: z.string() });
const problemsSchema = z.object({
  message: z.string(),
  problems: z.array(z.string()),
});

const apiKeyRoleSchema = z.enum(["fsm_admin", "fsm_operator"]);

export const loadFsm = createRoute({
  path: "/admin/fsm/load",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(
      z.object({
        definitions: z.array(z.object({
          fsmName: z.string().min(1),
          fsmVersion: z.string().min(1),
          fsmJson: z.record(z.unknown()),
        })).min(1),
      }),
      "FSM definitions to load in one transaction (SPEC-006): the same batch `pgfsmctl fsm load` builds from <folder>/<fsmName>/<vNN>/fsm.json",
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        data: z.array(z.object({
          fsmName: z.string(),
          fsmVersion: z.string(),
          status: z.enum(["loaded", "unchanged"]),
        })),
      }),
      "Every definition loaded (or already loaded with identical content)",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      problemsSchema,
      "The batch was rejected; nothing was written",
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      problemsSchema,
      "The database denied the load (the request's role lacks the grant)",
    ),
  },
});

export const listKeys = createRoute({
  path: "/admin/keys",
  method: "get",
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        data: z.array(z.object({
          id: z.string(),
          name: z.string(),
          role: apiKeyRoleSchema,
          prefix: z.string(),
          created_at: z.string(),
          last_used_at: z.string().nullable(),
          revoked_at: z.string().nullable(),
        })),
      }),
      "Every API key, newest first, without hashes",
    ),
  },
});

export const createKey = createRoute({
  path: "/admin/keys",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(
      z.object({
        name: z.string().min(1),
        role: apiKeyRoleSchema,
      }),
      "Name and role of the new key",
    ),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(
      z.object({
        data: z.object({
          id: z.string(),
          name: z.string(),
          role: apiKeyRoleSchema,
          prefix: z.string(),
          key: z.string().describe("The only copy of the key; store it now"),
        }),
      }),
      "Key created",
    ),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      messageSchema,
      "A key with that name exists",
    ),
  },
});

export const revokeKey = createRoute({
  path: "/admin/keys/{idOrName}",
  method: "delete",
  tags,
  request: {
    params: z.object({ idOrName: z.string().min(1) }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({ data: z.object({ revoked: z.literal(true) }) }),
      "Key revoked",
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      messageSchema,
      "No live key with that id or name",
    ),
  },
});

export type LoadFsmRoute = typeof loadFsm;
export type ListKeysRoute = typeof listKeys;
export type CreateKeyRoute = typeof createKey;
export type RevokeKeyRoute = typeof revokeKey;
