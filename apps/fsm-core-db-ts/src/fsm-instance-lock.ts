import type { Database as DatabaseGenerated } from "./database.types.ts";
import type { DBDeps } from "./custom-type.ts";

import { FSM_SCHEMA } from "./const.ts";


export async function lockFsmInstance(
  deps: DBDeps,
  p_fsm_instance_id: DatabaseGenerated["fsm_core"]["Functions"]["lock_fsm_instance"]["Args"]["p_fsm_instance_id"],
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
    const values = [p_fsm_instance_id, lockedBy];
    const res = await deps.db.query<{ locked: boolean }>(text, values);
    return res.rows?.[0]?.locked === true;
  } catch (err) {
    console.error("Error in lockFsmInstance:", err);

    throw new Error("Failed to acquire FSM DB lock", { cause: err });
  }
}

export async function unlockFsmInstance(
  deps: DBDeps,
  p_fsm_instance_id: DatabaseGenerated["fsm_core"]["Functions"]["unlock_fsm_instance"]["Args"]["p_fsm_instance_id"],
): Promise<boolean> {
  try {
    const UNLOCK_FSM_INSTANCE_FN = `${FSM_SCHEMA}.unlock_fsm_instance`;
    const text = `
      SELECT ${UNLOCK_FSM_INSTANCE_FN}(
        $1::uuid
      ) AS unlocked;
    `;
    const res = await deps.db.query<{ unlocked: boolean }>(text, [p_fsm_instance_id]);
    return res.rows?.[0]?.unlocked === true;
  } catch (err) {
    console.error("Error in unlockFsmInstance:", err);
    throw new Error("Failed to release FSM DB lock", { cause: err });
  }
}
