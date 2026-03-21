import type { Database } from "./database.types.ts";
import type { DBDeps } from "./custom-type.ts";

import { QUEUE_SCHEMA } from "./const.ts";


const DELETE_QUEUE_FN = `${QUEUE_SCHEMA}.delete`;
const ARCHIVE_QUEUE_FN = `${QUEUE_SCHEMA}.archive`;
const LIST_QUEUES_FN = `${QUEUE_SCHEMA}.list_queues`;

export async function readMessage(
  deps: DBDeps,
  queueName: string,
  vt: number,
): Promise<Database["pgmq"]["CompositeTypes"]["message_record"][]> {
  try {
    const READ_QUEUE_FN = `${QUEUE_SCHEMA}.read`;
    const qty = 1; // Read one message at a time for processing
    const text = `
      SELECT * FROM ${READ_QUEUE_FN}(
        $1::text,
        $2::integer,
        $3::integer
      );
    `;
    const res = await deps.db.query<
      Database["pgmq"]["CompositeTypes"]["message_record"]
    >(text, [queueName, vt, qty]);
    return res.rows ?? [];
  } catch (err) {
    console.error("Error in readMessage:", err);
    return [];
  }
}

export async function deleteMessage(
  deps: DBDeps,
  queueName: string,
  msgId: number,
): Promise<void> {
  try {
    const text = `
      SELECT * FROM ${DELETE_QUEUE_FN}(
        $1::text,
        $2::bigint
      );
    `;
    await deps.db.query(text, [queueName, msgId]);
  } catch (err) {
    console.error("Error in deleteMessage:", err);
  }
}

export async function archiveMessage(
  deps: DBDeps,
  queueName: string,
  msgId: number,
): Promise<void> {
  try {
    const text = `
      SELECT * FROM ${ARCHIVE_QUEUE_FN}(
        $1::text,
        $2::bigint
      );
    `;
    await deps.db.query(text, [queueName, msgId]);
  } catch (err) {
    console.error("Error in archiveMessage:", err);
  }
}


/**
 * Checks whether a PGMQ queue with the given name exists in the database.
 * Uses the `${QUEUE_SCHEMA}.list_queues()` wrapper when available.
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
    const text = `
      SELECT * FROM ${LIST_QUEUES_FN}();
    `;
    const res = await deps.db.query(text);
    const rows = res.rows ?? [];
    return rows.some((r: any) =>
      r?.name === queueName || r?.queue_name === queueName
    );
  } catch (err) {
    console.error("Error in pgmqQueueExists:", err);
    return false;
  }
}
