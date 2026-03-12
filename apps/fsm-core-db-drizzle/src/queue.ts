import { sql } from "drizzle-orm";

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
    const query = sql`
      SELECT * FROM ${sql.raw(READ_QUEUE_FN)}(
        ${queueName}::text,
        ${vt}::integer,
        ${qty}::integer
      );
    `;
    const res = await deps.db.execute(query);
    return res.rows;
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
    const query = sql`
      SELECT * FROM ${sql.raw(DELETE_QUEUE_FN)}(
        ${queueName}::text,
        ${msgId}::bigint
      );
    `;
    await deps.db.execute(query);
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
    const query = sql`
      SELECT * FROM ${sql.raw(ARCHIVE_QUEUE_FN)}(
        ${queueName}::text,
        ${msgId}::bigint
      );
    `;
    await deps.db.execute(query);
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
    const query = sql`
      SELECT * FROM ${sql.raw(LIST_QUEUES_FN)}();
    `;
    const res = await deps.db.execute(query);
    const rows = res.rows ?? [];
    return rows.some((r: any) =>
      r?.name === queueName || r?.queue_name === queueName
    );
  } catch (err) {
    console.error("Error in pgmqQueueExists:", err);
    return false;
  }
}
