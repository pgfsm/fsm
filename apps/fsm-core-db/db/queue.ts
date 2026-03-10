import type { Database } from "../database.types.ts";
import type { DBDeps } from "./custom-type.ts";

export async function tryFSMDBLock(
  deps: DBDeps,
  fsmInstanceId: string,
): Promise<boolean> {
  const lockedBy = "some-identifier"; // Replace with actual identifier
  // For direct SQL, call the function and return the boolean result
  const res = await deps.db.execute(
    `SELECT lock_fsm_instance('${fsmInstanceId}', '${lockedBy}') AS locked;`,
  );
  return res.rows[0]?.locked === true;
}

export async function releaseFSMDBLock(
  deps: DBDeps,
  fsmInstanceId: string,
): Promise<boolean> {
  // For direct SQL, call the function and return the boolean result
  const res = await deps.db.execute(
    `SELECT unlock_fsm_instance('${fsmInstanceId}') AS unlocked;`,
  );
  return res.rows[0]?.unlocked === true;
}

export async function readMessage(
  deps: DBDeps,
  queueName: string,
  vt: number,
): Promise<Database["pgmq"]["CompositeTypes"]["message_record"][]> {
  const res = await deps.db.execute(
    `SELECT * FROM pgmq.read('${queueName}', ${vt});`,
  );
  return res.rows;
}

export async function deleteMessage(
  deps: DBDeps,
  queueName: string,
  msgId: number,
): Promise<void> {
  await deps.db.execute(`SELECT * FROM pgmq.delete('${queueName}', ${msgId});`);
}

export async function archiveMessage(
  deps: DBDeps,
  queueName: string,
  msgId: number,
): Promise<void> {
  await deps.db.execute(
    `SELECT * FROM pgmq.archive('${queueName}', ${msgId});`,
  );
}

export async function isFSMQueuePresent(
  deps: DBDeps,
  queue: string,
): Promise<boolean> {
  // Drizzle/pg: Use positional parameters ($1) only if supported. Otherwise, interpolate safely.
  // For Deno Postgres and Drizzle, use parameterized query with ?
  const result = await deps.db.execute(
    `SELECT id FROM fsm_instance WHERE id = '${queue}';`,
  );
  return Array.isArray(result.rows) ? result.rows[0] : !!result.rows;
}

/**
 * Checks whether a PGMQ queue with the given name exists in the database.
 * Uses the `public.list_queues()` wrapper when available.
 * @param deps - DBDeps containing either supabase or drizzle client
 * @param queueName - The PGMQ queue name to check
 * @returns Promise<boolean>
 */
export async function pgmqQueueExists(
  deps: DBDeps,
  queueName: string,
): Promise<boolean> {
  if (!queueName) return false;
  try {
    const res = await deps.db.execute(`SELECT * FROM public.list_queues();`);
    const rows = res.rows ?? [];
    return rows.some((r: any) =>
      r?.name === queueName || r?.queue_name === queueName
    );
  } catch (err) {
    console.error("Unexpected error checking pgmq queues (direct):", err);
    return false;
  }
}
