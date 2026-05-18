import * as HttpStatusCodes from "stoker/http-status-codes.ts";

import type { AppRouteHandler } from "../../lib/types.ts";

import type { CreateRoute, ListRoute } from "./fsmworker.routes.ts";
import { getSupabase } from "../../middlewares/supabase.ts";

import { getFsmDataResolveStateValue } from "@fsm/db";

import { startFSMWorkerWithDBLock } from "@fsm/worker";

export const activeFSMLocks: Record<string, boolean> = {};

export const list: AppRouteHandler<ListRoute> = async (c) => {
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
  const body = c.req.valid("json");
  const queue = body.queue;

  try {
    if (!queue) {
      return c.json(
        { error: "Missing queue parameter" },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }

    const fsmData = await getFsmDataResolveStateValue(deps, queue);
    if (!fsmData) {
      return c.json(
        { error: "Invalid queue id — FSM instance not found" },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }

    if (activeFSMLocks[queue]) {
      return c.json(
        { error: `🚫 fsmworker already running for queue "${queue}"` },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }

    const verifiedModules = c.get("verifiedFsmModules");
    const matchedModule = verifiedModules?.find(
      (m: any) =>
        m.fsmName === (fsmData.fsm_instance_row.fsm_name ?? "") &&
        m.fsmVersion === (fsmData.fsm_instance_row.fsm_version ?? ""),
    );

    const started = await startFSMWorkerWithDBLock(
      deps,
      queue,
      fsmData.fsm_instance_row.fsm_name ?? "",
      fsmData.fsm_instance_row.fsm_version ?? "",
      activeFSMLocks,
      matchedModule ?? {},
      false,
    );

    if (started) {
      return c.json({}, HttpStatusCodes.OK);
    } else {
      return c.json(
        { error: `🚫 fsmworker already running for queue "${queue}"` },
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
