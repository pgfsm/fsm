import * as HttpStatusCodes from "stoker/http-status-codes.ts";
import { getLogger } from "@logtape/logtape";

import type { AppRouteHandler } from "../../lib/types.ts";
import type { CreateAndDispatchRoute, ResumeViaDispatchRoute } from "./fsm.routes.ts";
import { createFsmInstanceFromName, enqueueDispatch, resumeEventForFsmWorker } from "@pgfsm/db";
import type { Json } from "@pgfsm/db";

const logger = getLogger(["@pgfsm/api", "fsm.dispatch"]);

// createAndDispatch: creates FSM instance then enqueues to the scheduler via
// fsm_dispatch_queue. The scheduler selects a fsmlet and routes the work.
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

    // false = do not auto-enqueue to pgmq; we enqueue to fsm_dispatch_queue below.
    const fsm_instance = await createFsmInstanceFromName(
      deps,
      input_fsm_name,
      input_fsm_version,
      input_fsm_context as Json,
      false,
    ) as Record<string, string> | null;

    if (!fsm_instance?.fsm_instance_id) {
      return c.json({ error: "FSM instance creation failed" }, HttpStatusCodes.INTERNAL_SERVER_ERROR);
    }

    await enqueueDispatch(deps, fsm_instance.fsm_instance_id, input_fsm_name, input_fsm_version ?? "", "start");

    return c.json({ data: { fsm_instance } }, HttpStatusCodes.OK);
  } catch (_err) {
    logger.error("Error in createAndDispatch handler: {error}", { error: _err });
    return c.json({ error: "Unexpected error" }, HttpStatusCodes.INTERNAL_SERVER_ERROR);
  }
};

// resumeViaDispatch: single PG call — resume_event_for_fsm_worker_v2 looks up
// fsm_name/version, inserts into fsm_dispatch_queue, and notifies the scheduler.
export const resumeViaDispatch: AppRouteHandler<ResumeViaDispatchRoute> = async (c) => {
  const db = c.get("db");
  const deps = { db, useSupabase: false };
  const body = c.req.valid("json");
  const queue = body.queue;

  try {
    if (!queue) {
      return c.json({ error: "Missing queue parameter" }, HttpStatusCodes.INTERNAL_SERVER_ERROR);
    }

    const result = await resumeEventForFsmWorker(deps, queue);

    if (result.status === "fsm_not_found") {
      return c.json({ error: "Invalid queue id — FSM instance not found" }, HttpStatusCodes.NOT_FOUND);
    }

    return c.json({ data: result }, HttpStatusCodes.OK);
  } catch (_err) {
    logger.error("Error in resumeViaDispatch handler: {error}", { error: _err });
    return c.json({ error: "Unexpected error" }, HttpStatusCodes.INTERNAL_SERVER_ERROR);
  }
};
