import * as HttpStatusCodes from "stoker/http-status-codes.ts";
import { getLogger } from "@logtape/logtape";

import type { AppRouteHandler } from "../../lib/types.ts";

const logger = getLogger(["@pgfsm/api", "fsmpromise"]);

import type { ListRoute, ResumeRoute, StopRoute } from "./fsmpromise.routes.ts";
import { getSupabase } from "../../middlewares/supabase.ts";

import { startFSMPromiseWorker } from "@pgfsm/worker";
import { pgmqQueueExists } from "@pgfsm/db";

// lock=true: worker running. lock=false: stop requested, worker finishing current iteration.
// Entry is deleted by the onStop callback / .then()/.catch() cleanup once the worker loop exits.
type FsmPromiseWorkerEntry = { lock: boolean; controller: AbortController };
export const activePromiseWorkers: Record<string, FsmPromiseWorkerEntry> = {};

export const list: AppRouteHandler<ListRoute> = (c) => {
  const data = Object.fromEntries(
    Object.entries(activePromiseWorkers).map(([k, v]) => [k, v.lock]),
  );
  return c.json({ data }, HttpStatusCodes.OK);
};

export const resume: AppRouteHandler<ResumeRoute> = async (c) => {
  const supabase = getSupabase(c);
  const db = c.get("db");
  const deps = {
    db: db,
    useSupabase: true,
    supabase: supabase,
  };
  const body = c.req.valid("json");
  const { promise_name, promise_type, promise_version, fsm_name, fsm_version } =
    body;

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
      (m) => m.fsmName === fsm_name && m.fsmVersion === fsm_version,
    );

    const controller = new AbortController();
    startFSMPromiseWorker(
      deps,
      promise_name,
      promise_name,
      promise_type,
      promise_version,
      matchedModule,
      controller.signal,
    )
      .then(() => {
        delete activePromiseWorkers[promise_name];
      })
      .catch((err) => {
        logger.error("Promise worker for {name} stopped: {error}", {
          name: promise_name,
          error: err,
        });
        delete activePromiseWorkers[promise_name];
      });

    activePromiseWorkers[promise_name] = { lock: true, controller };
    return c.json({}, HttpStatusCodes.OK);
  } catch (_err) {
    logger.error("Error in resume handler: {error}", { error: _err });
    return c.json(
      { error: "Unexpected error" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};

export const stop: AppRouteHandler<StopRoute> = (c) => {
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
