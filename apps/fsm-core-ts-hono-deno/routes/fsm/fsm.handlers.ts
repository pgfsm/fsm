import * as HttpStatusCodes from "stoker/http-status-codes.ts";

import type { AppRouteHandler } from "../../lib/types.ts";

import type { CreateRoute, ListRoute, SendRoute } from "./fsm.routes.ts";
import { getSupabase } from "../../middlewares/supabase.ts";

import { createAndStartFSMWorker } from "@fsm/worker";

import { listFsmInstances, sendEventToFsmQueueWithEventLogs } from "@fsm/db";

import { activeFSMLocks } from "../fsmworker/fsmworker.handlers.ts";

export const list: AppRouteHandler<ListRoute> = async (c) => {
  const supabase = getSupabase(c);
  const db = c.get("db");
  const deps = {
    db: db,
    useSupabase: true,
    supabase: supabase,
  };

  const instances = await listFsmInstances(deps);
  return c.json({ data: instances }, HttpStatusCodes.OK);
};

export const create: AppRouteHandler<CreateRoute> = async (c) => {
  const supabase = getSupabase(c);
  const db = c.get("db");
  const deps = {
    db: db,
    useSupabase: true,
    supabase: supabase,
  };
  const body = c.req.valid("json");
  const input_fsm_name = body.fsm_name;
  const input_fsm_version = body.fsm_version;
  const input_fsm_context = body.fsm_context ?? {};

  try {
    if (!input_fsm_name) {
      return c.json(
        { error: "Missing fsm_name" },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }

    const verifiedModules = c.get("verifiedFsmModules");
    const matchedModule = verifiedModules?.find(
      (m: any) => m.fsmName === input_fsm_name && m.fsmVersion === input_fsm_version,
    );

    const fsm_instance = await createAndStartFSMWorker(
      deps,
      input_fsm_name,
      input_fsm_version,
      matchedModule ?? {},
      activeFSMLocks,
      input_fsm_context,
    );

    if (fsm_instance) {
      return c.json({ data: fsm_instance }, HttpStatusCodes.OK);
    } else {
      return c.json(
        { error: "FSM instance creation failed" },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }
  } catch (_err) {
    console.log("Error in create handler:", _err);
    return c.json(
      { error: "Unexpected error" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};

export const send: AppRouteHandler<SendRoute> = async (c) => {
  const supabase = getSupabase(c);
  const db = c.get("db");
  const deps = {
    db: db,
    useSupabase: true,
    supabase: supabase,
  };
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

    const instance = await sendEventToFsmQueueWithEventLogs(
      deps,
      fsm_instance_id,
      null,
      null,
      null,
      null,
      null,
      event_data?.type ?? "",
      "external",
      event_data,
      0,
    );

    return c.json({ data: instance }, HttpStatusCodes.OK);
  } catch (_err) {
    console.log("Error in send handler:", _err);
    return c.json(
      { error: "Unexpected error" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};
