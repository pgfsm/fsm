import * as HttpStatusCodes from "stoker/http-status-codes.ts";
import { getLogger } from "@logtape/logtape";

import type { AppRouteHandler } from "../../lib/types.ts";
import type { CreateAndDispatchRoute, ResumeViaDispatchRoute } from "./fsm.routes.ts";
import { getSupabase } from "../../middlewares/supabase.ts";
import { createFsmInstanceFromName, sendMessage, getFsmDataResolveStateValue } from "@pgfsm/db";

const logger = getLogger(["@pgfsm/api", "fsm.dispatch"]);

const DISPATCH_QUEUE_RESUME = "master_worker_dispatch_queue_resume";

// createAndDispatch: creates FSM instance and enqueues it to the daemon start queue.
export const createAndDispatch: AppRouteHandler<CreateAndDispatchRoute> = async (c) => {
  const db = c.get("db");
  const deps = { db, useSupabase: false };
  const body = c.req.valid("json");
  const input_fsm_name = body.fsm_name;
  const input_fsm_version = body.fsm_version;
  const input_fsm_context = body.fsm_context ?? {};

  try {
    if (!input_fsm_name) {
      return c.json({ error: "Missing fsm_name" }, HttpStatusCodes.INTERNAL_SERVER_ERROR);
    }

    const fsm_instance = await createFsmInstanceFromName(
      deps,
      input_fsm_name,
      input_fsm_version,
      input_fsm_context,
      true,
    );

    if (!fsm_instance) {
      return c.json({ error: "FSM instance creation failed" }, HttpStatusCodes.INTERNAL_SERVER_ERROR);
    }

    return c.json({ data: { fsm_instance } }, HttpStatusCodes.OK);
  } catch (_err) {
    logger.error("Error in createAndDispatch handler: {error}", { error: _err });
    return c.json({ error: "Unexpected error" }, HttpStatusCodes.INTERNAL_SERVER_ERROR);
  }
};

// resumeViaDispatch: enqueues the FSM instance to the daemon resume queue.
export const resumeViaDispatch: AppRouteHandler<ResumeViaDispatchRoute> = async (c) => {
  const supabase = getSupabase(c);
  const db = c.get("db");
  const deps = { db, useSupabase: true, supabase };
  const body = c.req.valid("json");
  const queue = body.queue;

  try {
    if (!queue) {
      return c.json({ error: "Missing queue parameter" }, HttpStatusCodes.INTERNAL_SERVER_ERROR);
    }

    const fsmData = await getFsmDataResolveStateValue(deps, queue);
    if (!fsmData) {
      return c.json({ error: "Invalid queue id — FSM instance not found" }, HttpStatusCodes.INTERNAL_SERVER_ERROR);
    }

    await sendMessage(deps, DISPATCH_QUEUE_RESUME, {
      id: queue,
      fsm_name: fsmData.fsm_instance_row.fsm_name,
      fsm_version: fsmData.fsm_instance_row.fsm_version,
    });

    return c.json({ data: { queued: true, queue } }, HttpStatusCodes.OK);
  } catch (_err) {
    logger.error("Error in resumeViaDispatch handler: {error}", { error: _err });
    return c.json({ error: "Unexpected error" }, HttpStatusCodes.INTERNAL_SERVER_ERROR);
  }
};
