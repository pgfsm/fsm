import * as HttpStatusCodes from "stoker/http-status-codes.ts";
import { getLogger } from "@logtape/logtape";

import type { AppRouteHandler } from "../../lib/types.ts";
import type {
  GetOneRoute,
  ListRoute,
  SendRoute,
  StopRoute,
} from "./fsm.routes.ts";
import { getSupabase } from "../../middlewares/supabase.ts";
import {
  API_SYSTEM_EVENT_NAME,
  API_SYSTEM_QUEUE_TYPE,
  API_SYSTEM_QUEUE_UUID,
  getFSMData,
  getFsmDataResolveStateValue,
  type Json,
  listFsmInstances,
  sendEventToFsmQueueWithEventLogs,
  stopEventForFsmWorker,
} from "@pgfsm/db";

const logger = getLogger(["@pgfsm/api", "fsm"]);

// Cast bridges the Hono jsr-vs-npm dual-package types and sidesteps the
// zod-openapi deep-instantiation blowup (TS2589); the RHS annotation keeps
// `c` fully typed.
// @ts-expect-error Hono jsr-vs-npm dual-package + zod-openapi deep response
// union trips TS2589/TS2322 on the handler assignment. Suppressed here; the body
// stays fully typed and this directive self-clears once the Hono packages are
// aligned to one registry.
export const list: AppRouteHandler<ListRoute> = async (c) => {
  const supabase = getSupabase(c);
  const db = c.get("db");
  const deps = { db, useSupabase: true, supabase };

  const instances = await listFsmInstances(deps);
  return c.json({ data: instances }, HttpStatusCodes.OK);
};

export const getOne: AppRouteHandler<GetOneRoute> = async (c) => {
  const supabase = getSupabase(c);
  const db = c.get("db");
  const deps = { db, useSupabase: true, supabase };
  const { id } = c.req.valid("param");

  try {
    const result = await getFsmDataResolveStateValue(deps, String(id));
    if (!result) {
      return c.json(
        { message: "FSM instance not found" },
        HttpStatusCodes.NOT_FOUND,
      );
    }
    return c.json({ data: result }, HttpStatusCodes.OK);
  } catch (_err) {
    logger.error("Error in getOne handler: {error}", { error: _err });
    return c.json(
      { error: "Unexpected error" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};

export const stop: AppRouteHandler<StopRoute> = async (c) => {
  const { queue } = c.req.valid("json");
  const db = c.get("db");
  const deps = { db, useSupabase: false };

  try {
    await stopEventForFsmWorker(deps, queue);
    return c.json({}, HttpStatusCodes.OK);
  } catch (_err) {
    logger.error("Error in stop handler: {error}", { error: _err });
    return c.json(
      { error: "Unexpected error" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};

export const send: AppRouteHandler<SendRoute> = async (c) => {
  const supabase = getSupabase(c);
  const db = c.get("db");
  const deps = { db, useSupabase: true, supabase };
  const body = c.req.valid("json");
  const fsm_instance_id = body.fsm_instance_id;
  const event_data = body.event_data;

  try {
    if (!fsm_instance_id && !event_data) {
      return c.json(
        { error: "Missing fsm_instance_id and event_data" },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }

    const fsmInstance = await getFSMData(deps, fsm_instance_id);
    if (!fsmInstance) {
      return c.json(
        { message: "FSM instance not found" },
        HttpStatusCodes.NOT_FOUND,
      );
    }

    const instance = await sendEventToFsmQueueWithEventLogs(
      deps,
      fsm_instance_id,
      fsmInstance.fsm_type ?? null,
      fsmInstance.fsm_version ?? null,
      API_SYSTEM_QUEUE_UUID,
      API_SYSTEM_QUEUE_TYPE,
      API_SYSTEM_EVENT_NAME,
      event_data?.type ?? "",
      "external",
      event_data as unknown as Json,
      0,
    );

    return c.json({ data: instance }, HttpStatusCodes.OK);
  } catch (_err) {
    logger.error("Error in send handler: {error}", { error: _err });
    return c.json(
      { error: "Unexpected error" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};
