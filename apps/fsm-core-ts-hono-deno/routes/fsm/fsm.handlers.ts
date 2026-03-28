import { eq } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes.ts";
import * as HttpStatusPhrases from "stoker/http-status-phrases.ts";

import type { AppRouteHandler } from "../../lib/types.ts";

// import { pool as db } from "../../../fsm-core-db-ts/src/pg-client.ts"

import { ZOD_ERROR_CODES, ZOD_ERROR_MESSAGES } from "../../lib/constants.ts";

import type { CreateRoute, ListRoute, SendRoute } from "./fsm.routes.ts";
import { getSupabase } from "../../middlewares/supabase.ts";

import { createAndStartFSMWorker } from "@fsm/worker";

import { DBDeps, sendFSMEvent } from "@fsm/db";

export const activeFSMLocks: Record<string, boolean> = {};

export const list: AppRouteHandler<ListRoute> = async (c) => {
  const supabase = getSupabase(c);
  const db = c.get("db");
  const deps = {
    db: db,
    useSupabase: true,
    supabase: supabase,
  };

  // const queue = c.req.query("queue");
  // const body = c.req.valid("json");
  // const queue = body.queue

  // Only allow 200
  return c.json({ data: activeFSMLocks }, HttpStatusCodes.OK);
};

export const create: AppRouteHandler<CreateRoute> = async (c) => {
  const supabase = getSupabase(c);
  const db = c.get("db");
  const deps = {
    db: db,
    useSupabase: true,
    supabase: supabase,
  };
  // const queue = c.req.query("queue");
  const body = c.req.valid("json");
  const input_fsm_name = body.fsm_name;
  const input_fsm_version = body.fsm_version;
  // Only allow 200 or 500 responses to match OpenAPI contract
  try {
    if (!input_fsm_name) {
      return c.json(
        { error: "Missing ?queue parameter" },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }
    const verifiedModules = c.get("verifiedModules");
    const matchedModule = verifiedModules?.find(
      (m) => m.fsmName === input_fsm_name && m.fsmVersion === input_fsm_version
    );

    const fsm_instance = await createAndStartFSMWorker(
      deps,
      input_fsm_name,
      input_fsm_version,
      matchedModule,
      activeFSMLocks,
      false,
    );

    if (fsm_instance) {
      return c.json({ data: fsm_instance }, HttpStatusCodes.OK);
    } else {
      return c.json(
        { error: "fsm instance creation failed" },
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
  // const queue = c.req.query("queue");
  const body = c.req.valid("json");
  const fsm_instance_id = body.fsm_instance_id;
  const event_data = body.event_data;
  try {
    if (!fsm_instance_id && !event_data) {
      // Always return 500 with error property for contract
      return c.json(
        { error: "Missing fsm_instance_id and event_data" },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }

    const instance = await sendFSMEvent(
      deps,
      event_data,
      { source: "system" },
      0,
      event_data?.type,
      fsm_instance_id,
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
