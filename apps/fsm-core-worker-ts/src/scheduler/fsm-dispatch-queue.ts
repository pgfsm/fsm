import { getLogger } from "@logtape/logtape";
import type { Pool } from "pg";

const logger = getLogger(["@pgfsm/scheduler", "dispatch-queue"]);

export const SCHEDULER_NOTIFY_CHANNEL = "fsm_scheduler_work";

export function fsmletNotifyChannel(fsmletId: string): string {
  return `fsm_fsmlet_work_${fsmletId}`;
}

export type FsmDispatchEntry = {
  id: number;
  instance_id: string;
  fsm_name: string;
  fsm_version: string;
};

/**
 * Thin wrapper around fsm_core.schedule_next_pending().
 * All scheduling logic (claim, filter+score fsmlets, assign, notify) runs
 * inside the PG function in a single transaction.
 * Returns true if an entry was scheduled, false if queue is empty or no
 * capable fsmlet is available.
 */
export async function scheduleNextPending(
  pool: Pool,
  staleThresholdSeconds = 30,
): Promise<boolean> {
  const res = await pool.query<{ schedule_next_pending: boolean }>(
    `SELECT fsm_core.schedule_next_pending($1)`,
    [staleThresholdSeconds],
  );
  const scheduled = res.rows[0]?.schedule_next_pending ?? false;
  if (scheduled) {
    logger.info("schedule_next_pending: entry scheduled");
  }
  return scheduled;
}

/**
 * Fsmlet: atomically claim one entry scheduled for this fsmlet and delete it.
 * The dispatch row is deleted immediately — the fsmlet's activeWorkers Map
 * tracks what is running; the fsm_instance table tracks FSM lifecycle state.
 *
 * Returns null if nothing is waiting (spurious notify or already claimed by
 * another coroutine on the same fsmlet).
 */
export async function claimScheduledForFsmlet(
  pool: Pool,
  fsmletId: string,
): Promise<FsmDispatchEntry | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const res = await client.query<FsmDispatchEntry>(
      `
      SELECT id, instance_id, fsm_name, fsm_version, dispatch_type
      FROM fsm_core.fsm_dispatch_queue
      WHERE status = 'scheduled' AND scheduled_fsmlet_id = $1
      ORDER BY scheduled_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `,
      [fsmletId],
    );

    if (res.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const entry = res.rows[0];
    await client.query(
      `DELETE FROM fsm_core.fsm_dispatch_queue WHERE id = $1`,
      [entry.id],
    );
    await client.query("COMMIT");
    return entry;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
