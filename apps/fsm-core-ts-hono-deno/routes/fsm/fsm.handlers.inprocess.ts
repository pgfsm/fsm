import * as HttpStatusCodes from "stoker/http-status-codes.ts";
import { getLogger } from "@logtape/logtape";

import type { AppRouteHandler } from "../../lib/types.ts";
import type {
  CreateRoute,
  CurrentActiveRoute,
  ResumeRoute,
} from "./fsm.routes.ts";
import { getSupabase } from "../../middlewares/supabase.ts";
import {
  createAndStartFSMWorker,
  startFSMWorkerWithDBLock,
} from "@pgfsm/worker";
import { getFsmDataResolveStateValue } from "@pgfsm/db";

const logger = getLogger(["@pgfsm/api", "fsm.inprocess"]);

// lock=true: worker running. lock=false: stop requested, worker finishing current iteration.
// Entry is deleted by the onStop callback once the worker loop exits.
type FsmWorkerEntry = { lock: boolean; controller: AbortController };
export const activeWorkers: Record<string, FsmWorkerEntry> = {};

// createAndStart: creates FSM instance and starts an in-process worker immediately.
export const createAndStart: AppRouteHandler<CreateRoute> = async (c) => {
  const supabase = getSupabase(c);
  const db = c.get("db");
  const deps = { db, useSupabase: true, supabase };
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
      (m) => m.fsmName === input_fsm_name && m.fsmVersion === input_fsm_version,
    );

    const controller = new AbortController();
    let instanceId: string | null = null;

    const { fsm_instance, workerResult } = await createAndStartFSMWorker(
      deps,
      input_fsm_name,
      input_fsm_version,
      matchedModule ?? {},
      input_fsm_context,
      false,
      controller.signal,
      () => {
        if (instanceId) delete activeWorkers[instanceId];
      },
    );

    if (!fsm_instance) {
      return c.json(
        { error: "FSM instance creation failed" },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }

    instanceId = fsm_instance.fsm_instance_id;
    activeWorkers[instanceId] = { lock: true, controller };
    return c.json({ data: { fsm_instance, workerResult } }, HttpStatusCodes.OK);
  } catch (_err) {
    logger.error("Error in createAndStart handler: {error}", { error: _err });
    return c.json(
      { error: "Unexpected error" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};

// resumeWithWorker: looks up the FSM instance and starts an in-process worker immediately.
export const resumeWithWorker: AppRouteHandler<ResumeRoute> = async (c) => {
  const supabase = getSupabase(c);
  const db = c.get("db");
  const deps = { db, useSupabase: true, supabase };
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

    if (activeWorkers[queue]) {
      return c.json(
        { error: `fsmworker already running for queue "${queue}"` },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }

    const verifiedModules = c.get("verifiedFsmModules");
    const matchedModule = verifiedModules?.find(
      (m) =>
        m.fsmName === (fsmData.fsm_instance_row.fsm_name ?? "") &&
        m.fsmVersion === (fsmData.fsm_instance_row.fsm_version ?? ""),
    );

    const controller = new AbortController();

    const workerResult = await startFSMWorkerWithDBLock(
      deps,
      queue,
      fsmData.fsm_instance_row.fsm_name ?? "",
      fsmData.fsm_instance_row.fsm_version ?? "",
      matchedModule ?? {},
      false,
      controller.signal,
      () => delete activeWorkers[queue],
    );

    if (workerResult.status === "fail") {
      return c.json(
        { error: workerResult.message },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }

    activeWorkers[queue] = { lock: true, controller };
    return c.json({ data: workerResult }, HttpStatusCodes.OK);
  } catch (_err) {
    logger.error("Error in resumeWithWorker handler: {error}", { error: _err });
    return c.json(
      { error: "Unexpected error" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};

export const currentActive: AppRouteHandler<CurrentActiveRoute> = (c) => {
  const data = Object.fromEntries(
    Object.entries(activeWorkers).map(([k, v]) => [k, v.lock]),
  );
  return c.json({ data }, HttpStatusCodes.OK);
};
