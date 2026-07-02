import { getLogger } from "@logtape/logtape";
import type { Database as DatabaseGenerated } from "./database.types.ts";
import type { DBDeps } from "./custom-type.ts";

const logger = getLogger(["@pgfsm/db", "queue"]);

import { QUEUE_SCHEMA } from "./const.ts";

const CREATE_QUEUE_FN = `${QUEUE_SCHEMA}.create`;
const DELETE_QUEUE_FN = `${QUEUE_SCHEMA}.delete`;
const ARCHIVE_QUEUE_FN = `${QUEUE_SCHEMA}.archive`;
const LIST_QUEUES_FN = `${QUEUE_SCHEMA}.list_queues`;

export async function createPgmqQueue(
  deps: DBDeps,
  queueName: string,
): Promise<void> {
  const text = `SELECT ${CREATE_QUEUE_FN}($1)`;
  await deps.db.query(text, [queueName]);
}

export async function readMessage(
  deps: DBDeps,
  queueName: string,
  vt: number,
): Promise<DatabaseGenerated["pgmq"]["CompositeTypes"]["message_record"][]> {
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
      DatabaseGenerated["pgmq"]["CompositeTypes"]["message_record"]
    >(text, [queueName, vt, qty]);
    return res.rows ?? [];
  } catch (err) {
    logger.error("Error in readMessage: {error}", { error: err });
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
    logger.error("Error in deleteMessage: {error}", { error: err });
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
    logger.error("Error in archiveMessage: {error}", { error: err });
  }
}

export async function sendMessage(
  deps: DBDeps,
  queueName: string,
  message: unknown,
): Promise<bigint | null> {
  try {
    const text = `SELECT ${QUEUE_SCHEMA}.send($1::text, $2::jsonb) AS msg_id`;
    const res = await deps.db.query<{ msg_id: bigint }>(text, [
      queueName,
      JSON.stringify(message),
    ]);
    return res.rows?.[0]?.msg_id ?? null;
  } catch (err) {
    logger.error("Error in sendMessage: {error}", { error: err });
    throw new Error("Failed to send message to queue", { cause: err });
  }
}

export async function pgmqQueueExists(
  deps: DBDeps,
  queueName: string,
): Promise<boolean> {
  if (!queueName) return false;
  try {
    const text = `
      SELECT * FROM ${LIST_QUEUES_FN}();
    `;
    const res = await deps.db.query<
      DatabaseGenerated["pgmq"]["CompositeTypes"]["queue_record"]
    >(text);
    const rows: DatabaseGenerated["pgmq"]["CompositeTypes"]["queue_record"][] =
      res.rows ?? [];
    return rows.some((r) => r?.queue_name === queueName);
  } catch (err) {
    logger.error("Error in pgmqQueueExists: {error}", { error: err });
    return false;
  }
}
