import { eq } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes.ts";
import * as HttpStatusPhrases from "stoker/http-status-phrases.ts";

import type { AppRouteHandler } from "../../lib/types.ts";

// import { pool as db } from "../../../fsm-core-db-ts/src/pg-client.ts";

import { ZOD_ERROR_CODES, ZOD_ERROR_MESSAGES } from "../../lib/constants.ts";

import type { CreateRoute, ListRoute } from "./fsmworker.routes.ts";
import { getSupabase } from "../../middlewares/supabase.ts";

import { isFSMInstancePresent } from "@fsm/db";

import { startFSMWorkerWithDBLock } from "@fsm/worker";

import { activeFSMLocks } from "../fsm/fsm.handlers.ts";

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
  const queue = body.queue;
  // Only allow 200 or 500 responses to match OpenAPI contract
  try {
    if (!queue) {
      // Always return 500 with error property for contract
      return c.json(
        { error: "Missing ?queue parameter" },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }
    const fsm_instance_object = await isFSMInstancePresent(deps, queue);
    // Validate queue is present in fsm_instance table
    if (!fsm_instance_object) {
      return c.json(
        { error: "Invalid queue id" },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }
    // tryLock expects 2 arguments: deps, queue
    // TODO: verify why try lock is not working as we are using supabase and not pg_client session
    if (activeFSMLocks[queue]) {
      return c.json(
        {
          error: `🚫 fsmworker already running for queue "${queue}"`,
        },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    } else {
      const verifiedModules = c.get("verifiedModules");
      const matchedModule = verifiedModules?.find(
        (m) => m.fsmName === fsm_instance_object.fsm_name && m.fsmVersion === fsm_instance_object.fsm_version,
      );
      const started = await startFSMWorkerWithDBLock(
        deps,
        queue,
        fsm_instance_object.fsm_name,
        fsm_instance_object.fsm_version,
        activeFSMLocks,
        matchedModule,
        false
      );
      if (started) {
        // Return empty object to match z.object({})
        return c.json({}, HttpStatusCodes.OK);
      } else {
        return c.json(
          {
            error: `🚫 fsmworker already running for queue "${queue}"`,
          },
          HttpStatusCodes.INTERNAL_SERVER_ERROR,
        );
      }
    }
  } catch (_err) {
    console.log("Error in list handler:", _err);
    return c.json(
      { error: "Unexpected error" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};
