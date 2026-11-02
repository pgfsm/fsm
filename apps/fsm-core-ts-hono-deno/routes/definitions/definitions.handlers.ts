import * as HttpStatusCodes from "stoker/http-status-codes.ts";
import { getFsmDefinition, listFsmDefinitions } from "@pgfsm/db";

import type { AppRouteHandler } from "../../lib/types.ts";
import type {
  GetOneRoute,
  ListRoute,
  VersionsRoute,
} from "./definitions.routes.ts";

export const list: AppRouteHandler<ListRoute> = async (c) => {
  const deps = { db: c.get("db"), useSupabase: false };
  const q = c.req.valid("query");
  const data = await listFsmDefinitions(deps, {
    fsmName: q.fsm_name,
    fsmVersion: q.fsm_version,
  });
  return c.json({ data }, HttpStatusCodes.OK);
};

export const versions: AppRouteHandler<VersionsRoute> = async (c) => {
  const deps = { db: c.get("db"), useSupabase: false };
  const { fsmName } = c.req.valid("param");
  const data = await listFsmDefinitions(deps, { fsmName });
  if (data.length === 0) {
    return c.json(
      { message: `No version of FSM ${fsmName} is loaded` },
      HttpStatusCodes.NOT_FOUND,
    );
  }
  return c.json({ data }, HttpStatusCodes.OK);
};

export const getOne: AppRouteHandler<GetOneRoute> = async (c) => {
  const deps = { db: c.get("db"), useSupabase: false };
  const { fsmName, fsmVersion } = c.req.valid("param");
  const row = await getFsmDefinition(deps, fsmName, fsmVersion);
  if (!row) {
    return c.json(
      { message: `FSM ${fsmName}/${fsmVersion} isn't loaded` },
      HttpStatusCodes.NOT_FOUND,
    );
  }
  return c.json({ data: row }, HttpStatusCodes.OK);
};
