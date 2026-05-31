import * as HttpStatusCodes from "stoker/http-status-codes.ts";

import type { AppRouteHandler } from "../../lib/types.ts";

import type { CreateRoute, CurrentActiveRoute, ListRoute, SendRoute, StartRoute, StopRoute } from "./fsm.routes.ts";
import { getSupabase } from "../../middlewares/supabase.ts";

import { createAndStartFSMWorker, startFSMWorkerWithDBLock } from "@pgfsm/worker";

import { listFsmInstances, sendEventToFsmQueueWithEventLogs, getFSMData, getFsmDataResolveStateValue, API_SYSTEM_QUEUE_UUID, API_SYSTEM_QUEUE_TYPE, API_SYSTEM_EVENT_NAME, type Json } from "@pgfsm/db";

// lock=true: worker running. lock=false: stop requested, worker finishing current iteration.
// Entry is deleted by the onStop callback once the worker loop exits.
type FsmWorkerEntry = { lock: boolean; controller: AbortController };
export const activeWorkers: Record<string, FsmWorkerEntry> = {};

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

    const controller = new AbortController();
    let instanceId: string | null = null;

    const fsm_instance = await createAndStartFSMWorker(
      deps,
      input_fsm_name,
      input_fsm_version,
      matchedModule ?? {},
      input_fsm_context,
      false,
      controller.signal,
      () => { if (instanceId) delete activeWorkers[instanceId]; },
    );

    if (fsm_instance) {
      instanceId = fsm_instance.fsm_instance_id;
      activeWorkers[instanceId] = { lock: true, controller };
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

export const currentActive: AppRouteHandler<CurrentActiveRoute> = async (c) => {
  const data = Object.fromEntries(
    Object.entries(activeWorkers).map(([k, v]) => [k, v.lock]),
  );
  return c.json({ data }, HttpStatusCodes.OK);
};

export const start: AppRouteHandler<StartRoute> = async (c) => {
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

    if (activeWorkers[queue]) {
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

    const controller = new AbortController();

    const started = await startFSMWorkerWithDBLock(
      deps,
      queue,
      fsmData.fsm_instance_row.fsm_name ?? "",
      fsmData.fsm_instance_row.fsm_version ?? "",
      matchedModule ?? {},
      false,
      controller.signal,
      () => delete activeWorkers[queue],
    );

    if (started) {
      activeWorkers[queue] = { lock: true, controller };
      return c.json({}, HttpStatusCodes.OK);
    } else {
      return c.json(
        { error: `🚫 fsmworker already running for queue "${queue}"` },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }
  } catch (_err) {
    console.log("Error in start handler:", _err);
    return c.json(
      { error: "Unexpected error" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};

export const stop: AppRouteHandler<StopRoute> = async (c) => {
  const { queue } = c.req.valid("json");
  const entry = activeWorkers[queue];
  if (!entry) {
    return c.json(
      { error: `No active worker for queue "${queue}"` },
      HttpStatusCodes.NOT_FOUND,
    );
  }
  entry.lock = false;
  entry.controller.abort();
  return c.json({}, HttpStatusCodes.OK);
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

    const fsmInstance = await getFSMData(deps, fsm_instance_id);
    if (!fsmInstance) {
      return c.json({ message: "FSM instance not found" }, HttpStatusCodes.NOT_FOUND);
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
    console.log("Error in send handler:", _err);
    return c.json(
      { error: "Unexpected error" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};
