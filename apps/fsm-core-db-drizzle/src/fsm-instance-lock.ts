import { sql } from "drizzle-orm";

import type { DBDeps } from "./custom-type.ts";

import { FSM_SCHEMA } from "./const.ts";






export async function tryFSMDBLock(
  deps: DBDeps,
  fsmInstanceId: string,
): Promise<boolean> {
  const lockedBy = "some-identifier"; // Replace with actual identifier
  try {
    const LOCK_FSM_INSTANCE_FN = `${FSM_SCHEMA}.lock_fsm_instance`;
    const query = sql`
      SELECT ${sql.raw(LOCK_FSM_INSTANCE_FN)}(
        ${fsmInstanceId}::uuid,
        ${lockedBy}::text
      ) AS locked;
    `;
    const res = await deps.db.execute(query);
    return res.rows[0]?.locked === true;
  } catch (err) {
    console.error("Error in tryFSMDBLock:", err);
    return false;
  }
}

export async function releaseFSMDBLock(
  deps: DBDeps,
  fsmInstanceId: string,
): Promise<boolean> {
  try {
    const UNLOCK_FSM_INSTANCE_FN = `${FSM_SCHEMA}.unlock_fsm_instance`;
    const query = sql`
      SELECT ${sql.raw(UNLOCK_FSM_INSTANCE_FN)}(
        ${fsmInstanceId}::uuid
      ) AS unlocked;
    `;
    const res = await deps.db.execute(query);
    return res.rows[0]?.unlocked === true;
  } catch (err) {
    console.error("Error in releaseFSMDBLock:", err);
    return false;
  }
}



