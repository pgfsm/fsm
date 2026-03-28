import { eq } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes.ts";
import * as HttpStatusPhrases from "stoker/http-status-phrases.ts";

import type { AppRouteHandler } from "../../lib/types.ts";

// import { pool as db } from "../../../fsm-core-db-ts/src/pg-client.ts";

import { ZOD_ERROR_CODES, ZOD_ERROR_MESSAGES } from "../../lib/constants.ts";

import type { CreateRoute, ListRoute, SendRoute } from "./fsmpromise.routes.ts";
import { getSupabase } from "../../middlewares/supabase.ts";

import { pgmqQueueExists } from "../../../fsm-core-db-ts/src/queue.ts";

import { startFSMPromiseWorker } from "../../../fsm-core-worker-ts/src/index.ts";

export const activePromiseLocks: Record<string, boolean> = {};

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
  // const queue = c.req.query("queue");
  const body = c.req.valid("json");
  const input_promise_name = body.promise_name;
  const input_promise_version = body.promise_version;
  // Only allow 200 or 500 responses to match OpenAPI contract
  try {
    if (!input_promise_name) {
      // Always return 500 with error property for contract
      return c.json(
        { error: "Missing ?queue parameter" },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }

    const promise_name = input_promise_name;
    // const promise_name = input_promise_name +  input_promise_version

    // Check that the PGMQ queue for this promise exists before creating instance
   
      const queueExists = await pgmqQueueExists(deps, promise_name);
      if (!queueExists) {
        console.warn(
          `PGMQ queue for promise "${promise_name}" does not exist.`,
        );
        // We still call RPC with create_pgmq_queue: true below, but inform the caller
        return c.json(
          { error: "PGMQ queue does not exist" },
          HttpStatusCodes.OK,
        );
      }else{

        console.log(`PGMQ queue for promise "${promise_name}" exists.`);
         startFSMPromiseWorker(
          deps,
          promise_name,
          promise_name,
          input_promise_version,
        ).catch((err) => {
          console.error(
            `Worker for queue "${promise_name}" has been stopped due to an error.`,
            err,
          );
        });

        return c.json({
          data: `fsm promise with fsm promise name "${promise_name}" is started`,
        }, HttpStatusCodes.OK);


      }
   

   
  } catch (_err) {
    console.log("Error in create handler:", _err);
    return c.json(
      { error: "Unexpected error" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};
