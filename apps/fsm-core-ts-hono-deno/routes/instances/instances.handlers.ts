import * as HttpStatusCodes from "stoker/http-status-codes.ts";
import { getLogger } from "@logtape/logtape";

import type { AppRouteHandler } from "../../lib/types.ts";
import type {
  CreateRoute,
  GetOneRoute,
  ListRoute,
  ResumeRoute,
  SendEventRoute,
  StopRoute,
} from "./instances.routes.ts";
import {
  createFsmInstanceFromName,
  getFSMData,
  getFsmDataResolveStateValue,
  type Json,
  listFsmInstances,
  resumeEventForFsmWorker,
  sendEventToFsmQueueWithEventLogs,
  stopEventForFsmWorker,
} from "@pgfsm/db";

const logger = getLogger(["@pgfsm/api", "instances"]);

const NOT_FOUND = { message: "FSM instance not found" };
const UNEXPECTED = { error: "Unexpected error" };

// Every route runs inside the API key's role (SPEC-009 §3): `db` is that
// role's transaction, set by the auth middleware.

// @ts-expect-error Hono jsr-vs-npm dual-package + zod-openapi deep response
// union trips TS2589 on the handler assignment. Suppressed here; the body
// stays fully typed and this directive self-clears once the Hono packages are
// aligned to one registry.
export const list: AppRouteHandler<ListRoute> = async (c) => {
  const deps = { db: c.get("db"), useSupabase: false };
  const instances = await listFsmInstances(deps);
  return c.json({ data: instances }, HttpStatusCodes.OK);
};

export const getOne: AppRouteHandler<GetOneRoute> = async (c) => {
  const deps = { db: c.get("db"), useSupabase: false };
  const { id } = c.req.valid("param");
  try {
    // get_fsm_data_resolve_state_value_v2 raises for an unknown id, so check
    // first: an unknown instance is a 404, as on every /instances/{id} route.
    if (!(await getFSMData(deps, id))) {
      return c.json(NOT_FOUND, HttpStatusCodes.NOT_FOUND);
    }
    const result = await getFsmDataResolveStateValue(deps, id);
    if (!result) return c.json(NOT_FOUND, HttpStatusCodes.NOT_FOUND);
    return c.json({ data: result }, HttpStatusCodes.OK);
  } catch (err) {
    logger.error("GET /instances/{id}: {error}", { id, error: err });
    return c.json(UNEXPECTED, HttpStatusCodes.INTERNAL_SERVER_ERROR);
  }
};

// Creates the instance and its pgmq queue, sends initialTransition_event, and
// enqueues it to fsm_dispatch_queue for the scheduler and an fsmlet.
export const create: AppRouteHandler<CreateRoute> = async (c) => {
  const deps = { db: c.get("db"), useSupabase: false };
  const { fsm_name, fsm_version, input } = c.req.valid("json");
  try {
    const instance = await createFsmInstanceFromName(
      deps,
      fsm_name,
      fsm_version,
      (input ?? {}) as Json,
      true,
    ) as Record<string, unknown> | null;
    if (!instance?.fsm_instance_id) {
      return c.json(
        { error: "FSM instance creation failed" },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }
    return c.json({ data: instance }, HttpStatusCodes.OK);
  } catch (err) {
    logger.error("POST /instances: {error}", { error: err });
    return c.json(UNEXPECTED, HttpStatusCodes.INTERNAL_SERVER_ERROR);
  }
};

export const sendEvent: AppRouteHandler<SendEventRoute> = async (c) => {
  const deps = { db: c.get("db"), useSupabase: false };
  const { id } = c.req.valid("param");
  const event = c.req.valid("json");
  try {
    const instance = await getFSMData(deps, id);
    if (!instance) return c.json(NOT_FOUND, HttpStatusCodes.NOT_FOUND);
    const data = await sendEventToFsmQueueWithEventLogs(
      deps,
      id,
      instance.fsm_type ?? null,
      instance.fsm_version ?? null,
      event.type,
      "external",
      event as unknown as Json,
      0,
    );
    return c.json({ data }, HttpStatusCodes.OK);
  } catch (err) {
    logger.error("POST /instances/{id}/events: {error}", { id, error: err });
    return c.json(UNEXPECTED, HttpStatusCodes.INTERNAL_SERVER_ERROR);
  }
};

// One call: resume_event_for_fsm_worker_v2 looks up the instance's FSM,
// re-enqueues it to fsm_dispatch_queue and notifies the scheduler.
export const resume: AppRouteHandler<ResumeRoute> = async (c) => {
  const deps = { db: c.get("db"), useSupabase: false };
  const { id } = c.req.valid("param");
  try {
    const result = await resumeEventForFsmWorker(deps, id);
    if (result.status === "fsm_not_found") {
      return c.json(NOT_FOUND, HttpStatusCodes.NOT_FOUND);
    }
    return c.json({ data: result }, HttpStatusCodes.OK);
  } catch (err) {
    logger.error("POST /instances/{id}/resume: {error}", { id, error: err });
    return c.json(UNEXPECTED, HttpStatusCodes.INTERNAL_SERVER_ERROR);
  }
};

export const stop: AppRouteHandler<StopRoute> = async (c) => {
  const deps = { db: c.get("db"), useSupabase: false };
  const { id } = c.req.valid("param");
  try {
    if (!(await getFSMData(deps, id))) {
      return c.json(NOT_FOUND, HttpStatusCodes.NOT_FOUND);
    }
    await stopEventForFsmWorker(deps, id);
    return c.json({}, HttpStatusCodes.OK);
  } catch (err) {
    logger.error("POST /instances/{id}/stop: {error}", { id, error: err });
    return c.json(UNEXPECTED, HttpStatusCodes.INTERNAL_SERVER_ERROR);
  }
};
