import type { DBDeps } from "./custom-type.ts";

import { FSM_SCHEMA } from "./const.ts";






export async function tryFSMDBLock(
  deps: DBDeps,
  fsmInstanceId: string,
): Promise<boolean> {
  const lockedBy = "some-identifier"; // Replace with actual identifier
  try {
    const LOCK_FSM_INSTANCE_FN = `${FSM_SCHEMA}.lock_fsm_instance`;
    const text = `
      SELECT ${LOCK_FSM_INSTANCE_FN}(
        $1::uuid,
        $2::text
      ) AS locked;
    `;
    const values = [fsmInstanceId, lockedBy];
    const res = await deps.db.query<{ locked: boolean }>(text, values);
    return res.rows?.[0]?.locked === true;
  } catch (err) {
    console.error("Error in tryFSMDBLock:", err);

    throw new Error("Failed to acquire FSM DB lock", { cause: err });
  }
}

export async function releaseFSMDBLock(
  deps: DBDeps,
  fsmInstanceId: string,
): Promise<boolean> {
  try {
    const UNLOCK_FSM_INSTANCE_FN = `${FSM_SCHEMA}.unlock_fsm_instance`;
    const text = `
      SELECT ${UNLOCK_FSM_INSTANCE_FN}(
        $1::uuid
      ) AS unlocked;
    `;
    const res = await deps.db.query<{ unlocked: boolean }>(text, [fsmInstanceId]);
    return res.rows?.[0]?.unlocked === true;
  } catch (err) {
    console.error("Error in releaseFSMDBLock:", err);
    throw new Error("Failed to release FSM DB lock", { cause: err });
  }
}



