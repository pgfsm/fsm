import * as HttpStatusCodes from "stoker/http-status-codes.ts";
import { getLogger } from "@logtape/logtape";
import {
  createApiKey,
  FsmDefinitionLoadError,
  type Json,
  listApiKeys,
  loadFsmDefinitions,
  registerSchedulerJob,
  revokeApiKey,
  schedulerJobStatus,
} from "@pgfsm/db";

import type { AppRouteHandler } from "../../lib/types.ts";
import type {
  CreateKeyRoute,
  GetSchedulerRoute,
  ListKeysRoute,
  LoadDefinitionsRoute,
  RegisterSchedulerRoute,
  RevokeKeyRoute,
} from "./admin.routes.ts";

const logger = getLogger(["@pgfsm/api", "admin"]);

/** The Postgres SQLSTATE of an error (or its cause), if any. */
const sqlState = (err: unknown): string | undefined => {
  for (let e = err; e && typeof e === "object"; e = (e as Error).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
};

// Handlers run inside the auth middleware's withRole(fsm_admin) transaction:
// c.get("db") is that transaction, so Postgres grants are what's enforced.

export const loadDefinitions: AppRouteHandler<LoadDefinitionsRoute> = async (
  c,
) => {
  const deps = { db: c.get("db"), useSupabase: false };
  const { definitions } = c.req.valid("json");
  try {
    const data = await loadFsmDefinitions(
      deps,
      definitions.map((d) => ({ ...d, fsmJson: d.fsmJson as Json })),
    );
    logger.info("Loaded {count} FSM definition(s)", { count: data.length });
    return c.json({ data }, HttpStatusCodes.OK);
  } catch (err) {
    if (!(err instanceof FsmDefinitionLoadError)) throw err;
    if (sqlState(err) === "42501") {
      return c.json(
        { message: "Permission denied", problems: err.problems },
        HttpStatusCodes.FORBIDDEN,
      );
    }
    return c.json(
      { message: "FSM definitions not loaded", problems: err.problems },
      HttpStatusCodes.UNPROCESSABLE_ENTITY,
    );
  }
};

export const listKeys: AppRouteHandler<ListKeysRoute> = async (c) => {
  const rows = await listApiKeys({ db: c.get("db"), useSupabase: false });
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  return c.json({
    data: rows.map((r) => ({
      ...r,
      created_at: r.created_at.toISOString(),
      last_used_at: iso(r.last_used_at),
      revoked_at: iso(r.revoked_at),
    })),
  }, HttpStatusCodes.OK);
};

export const createKey: AppRouteHandler<CreateKeyRoute> = async (c) => {
  const { name, role } = c.req.valid("json");
  try {
    const data = await createApiKey(
      { db: c.get("db"), useSupabase: false },
      name,
      role,
    );
    logger.info("Created {role} API key {name} ({prefix})", {
      role,
      name,
      prefix: data.prefix,
    });
    return c.json({ data }, HttpStatusCodes.CREATED);
  } catch (err) {
    if (sqlState(err) === "23505") {
      return c.json(
        { message: `An API key named ${JSON.stringify(name)} exists` },
        HttpStatusCodes.CONFLICT,
      );
    }
    throw err;
  }
};

export const revokeKey: AppRouteHandler<RevokeKeyRoute> = async (c) => {
  const { idOrName } = c.req.valid("param");
  const revoked = await revokeApiKey(
    { db: c.get("db"), useSupabase: false },
    idOrName,
  );
  if (!revoked) {
    return c.json(
      { message: "No live API key with that id or name" },
      HttpStatusCodes.NOT_FOUND,
    );
  }
  logger.info("Revoked API key {idOrName}", { idOrName });
  return c.json({ data: { revoked: true as const } }, HttpStatusCodes.OK);
};

export const getScheduler: AppRouteHandler<GetSchedulerRoute> = async (c) => {
  const data = await schedulerJobStatus({
    db: c.get("db"),
    useSupabase: false,
  });
  return c.json({ data }, HttpStatusCodes.OK);
};

export const registerScheduler: AppRouteHandler<RegisterSchedulerRoute> =
  async (c) => {
    // The body is optional: an empty POST registers the default schedule.
    const body = await c.req.json().catch(() => ({})) as { schedule?: unknown };
    if (
      body.schedule !== undefined &&
      (typeof body.schedule !== "string" || body.schedule === "")
    ) {
      return c.json(
        { message: "schedule must be a non-empty string" },
        HttpStatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
    try {
      const data = await registerSchedulerJob(
        { db: c.get("db"), useSupabase: false },
        body.schedule as string | undefined,
      );
      return c.json({ data }, HttpStatusCodes.OK);
    } catch (err) {
      // pg_cron raises a plain error for a schedule it can't parse.
      const message = (err as Error).message ?? "";
      if (/schedule/i.test(message) && sqlState(err) !== "42501") {
        return c.json({ message }, HttpStatusCodes.UNPROCESSABLE_ENTITY);
      }
      throw err;
    }
  };
