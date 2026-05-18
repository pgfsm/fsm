import * as HttpStatusCodes from "stoker/http-status-codes.ts";

import type { AppRouteHandler } from "../../lib/types.ts";

import type { CreateAndStartRoute, CreateRoute, ListRoute } from "./fsmpromise.routes.ts";
import { getSupabase } from "../../middlewares/supabase.ts";

import { createAndStartPromiseWorker, startFSMPromiseWorker } from "@fsm/worker";

export const activePromiseLocks: Record<string, boolean> = {};

export const list: AppRouteHandler<ListRoute> = async (c) => {
  return c.json({ data: activePromiseLocks }, HttpStatusCodes.OK);
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
  const { promise_name, promise_type, promise_version, fsm_name, fsm_version } = body;

  try {
    if (!promise_name) {
      return c.json(
        { error: "Missing promise_name" },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }

    const verifiedModules = c.get("verifiedFsmModules");
    const matchedModule = verifiedModules?.find(
      (m: any) => m.fsmName === fsm_name && m.fsmVersion === fsm_version,
    );

    const started = await startFSMPromiseWorker(
      deps,
      promise_name,
      promise_name,
      promise_type,
      promise_version,
      matchedModule,
    );

    if (!started) {
      return c.json(
        { error: "PGMQ queue does not exist" },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }

    return c.json({}, HttpStatusCodes.OK);
  } catch (_err) {
    console.log("Error in create handler:", _err);
    return c.json(
      { error: "Unexpected error" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};

export const createAndStart: AppRouteHandler<CreateAndStartRoute> = async (c) => {
  const supabase = getSupabase(c);
  const db = c.get("db");
  const deps = {
    db: db,
    useSupabase: true,
    supabase: supabase,
  };
  const body = c.req.valid("json");
  const { queue_name, fsm_name, promise_type, fsm_version } = body;

  try {
    const verifiedModules = c.get("verifiedFsmModules");
    const matchedModule = verifiedModules?.find(
      (m: any) => m.fsmName === fsm_name && m.fsmVersion === fsm_version,
    );

    const started = await createAndStartPromiseWorker(
      deps,
      queue_name,
      queue_name,
      promise_type,
      fsm_version,
      matchedModule,
    );

    if (!started) {
      return c.json(
        { error: "Failed to create queue or start promise worker" },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }

    return c.json({}, HttpStatusCodes.OK);
  } catch (_err) {
    console.log("Error in createAndStart handler:", _err);
    return c.json(
      { error: "Unexpected error" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};
