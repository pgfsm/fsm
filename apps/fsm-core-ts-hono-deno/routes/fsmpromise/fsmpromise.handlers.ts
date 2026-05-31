import * as HttpStatusCodes from "stoker/http-status-codes.ts";

import type { AppRouteHandler } from "../../lib/types.ts";

import type { CreateAndStartRoute, ListRoute, StartRoute, StopRoute } from "./fsmpromise.routes.ts";
import { getSupabase } from "../../middlewares/supabase.ts";

import { createAndStartPromiseWorker, startFSMPromiseWorker } from "@pgfsm/worker";
import { pgmqQueueExists } from "@pgfsm/db";

// lock=true: worker running. lock=false: stop requested, worker finishing current iteration.
// Entry is deleted by the onStop callback / .then()/.catch() cleanup once the worker loop exits.
type FsmPromiseWorkerEntry = { lock: boolean; controller: AbortController };
export const activePromiseWorkers: Record<string, FsmPromiseWorkerEntry> = {};

export const list: AppRouteHandler<ListRoute> = async (c) => {
  const data = Object.fromEntries(
    Object.entries(activePromiseWorkers).map(([k, v]) => [k, v.lock]),
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
  const { promise_name, promise_type, promise_version, fsm_name, fsm_version } = body;

  try {
    if (!promise_name) {
      return c.json(
        { error: "Missing promise_name" },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }

    if (activePromiseWorkers[promise_name]) {
      return c.json(
        { error: `Promise worker already running for "${promise_name}"` },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }

    const queueExists = await pgmqQueueExists(deps, promise_name);
    if (!queueExists) {
      return c.json(
        { error: "PGMQ queue does not exist" },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }

    const verifiedModules = c.get("verifiedFsmModules");
    const matchedModule = verifiedModules?.find(
      (m: any) => m.fsmName === fsm_name && m.fsmVersion === fsm_version,
    );

    const controller = new AbortController();
    startFSMPromiseWorker(deps, promise_name, promise_name, promise_type, promise_version, matchedModule, controller.signal)
      .then(() => { delete activePromiseWorkers[promise_name]; })
      .catch((err) => {
        console.error(`Promise worker for "${promise_name}" stopped:`, err);
        delete activePromiseWorkers[promise_name];
      });

    activePromiseWorkers[promise_name] = { lock: true, controller };
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
    if (activePromiseWorkers[queue_name]) {
      return c.json(
        { error: `Promise worker already running for "${queue_name}"` },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }

    const verifiedModules = c.get("verifiedFsmModules");
    const matchedModule = verifiedModules?.find(
      (m: any) => m.fsmName === fsm_name && m.fsmVersion === fsm_version,
    );

    const controller = new AbortController();
    const started = await createAndStartPromiseWorker(
      deps,
      queue_name,
      queue_name,
      promise_type,
      fsm_version,
      matchedModule,
      controller.signal,
      () => delete activePromiseWorkers[queue_name],
    );

    if (!started) {
      return c.json(
        { error: "Failed to create queue or start promise worker" },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }

    activePromiseWorkers[queue_name] = { lock: true, controller };
    return c.json({}, HttpStatusCodes.OK);
  } catch (_err) {
    console.log("Error in createAndStart handler:", _err);
    return c.json(
      { error: "Unexpected error" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};

export const stop: AppRouteHandler<StopRoute> = async (c) => {
  const { queue } = c.req.valid("json");
  const entry = activePromiseWorkers[queue];
  if (!entry) {
    return c.json(
      { error: `No active promise worker for queue "${queue}"` },
      HttpStatusCodes.NOT_FOUND,
    );
  }
  entry.lock = false;
  entry.controller.abort();
  return c.json({}, HttpStatusCodes.OK);
};
