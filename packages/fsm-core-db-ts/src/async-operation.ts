import { getLogger } from "@logtape/logtape";
import type { DBDeps } from "./custom-type.ts";
import { FSM_SCHEMA } from "./const.ts";

const logger = getLogger(["@pgfsm/db", "async-operation"]);

const ASYNC_OP_DISPATCH_TABLE =
  `${FSM_SCHEMA}.async_operation_instance_and_async_operation_workerlet`;
const ASYNC_OP_SCHEDULE_NEXT_PENDING_FN =
  `${FSM_SCHEMA}.async_operation_schedule_next_pending`;

export type AsyncOperationDispatchInput = {
  asyncOperationInstanceId: string;
  asyncOperationName: string;
  asyncOperationVersion: string;
  asyncOperationType: string;
  parentFsmName: string;
  parentFsmVersion: string;
  asyncOperationLanguage: string;
};

/**
 * Inserts a pending dispatch entry into async_operation_instance_and_async_operation_workerlet
 * and wakes the async-operation scheduler via pg_notify — in a single atomic CTE query.
 */
export async function enqueueAsyncOperationDispatch(
  deps: DBDeps,
  input: AsyncOperationDispatchInput,
): Promise<void> {
  await deps.db.query(
    `WITH ins AS (
       INSERT INTO ${ASYNC_OP_DISPATCH_TABLE}
         (async_operation_instance_id, async_operation_name, async_operation_version,
          async_operation_type, parent_fsm_name, parent_fsm_version, async_operation_language)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
       RETURNING async_operation_instance_id
     )
     SELECT pg_notify('async_operation_scheduler_work', async_operation_instance_id::text)
     FROM ins`,
    [
      input.asyncOperationInstanceId,
      input.asyncOperationName,
      input.asyncOperationVersion,
      input.asyncOperationType,
      input.parentFsmName,
      input.parentFsmVersion,
      input.asyncOperationLanguage,
    ],
  );
  logger.debug(
    "Enqueued async operation {instanceId} ({name}@{version}, type={type}, lang={lang})",
    {
      instanceId: input.asyncOperationInstanceId,
      name: input.asyncOperationName,
      version: input.asyncOperationVersion,
      type: input.asyncOperationType,
      lang: input.asyncOperationLanguage,
    },
  );
}

/**
 * Atomically claims the oldest pending async-operation dispatch entry, assigns it
 * to the best available workerlet, and fires pg_notify to wake that workerlet.
 * Returns true if an entry was scheduled, false if the queue is empty or no
 * workerlet has capacity. Safe to call from multiple scheduler replicas concurrently.
 */
export async function asyncOperationScheduleNextPending(
  deps: DBDeps,
  staleThresholdSeconds = 30,
): Promise<boolean> {
  const res = await deps.db.query<{ result: boolean }>(
    `SELECT ${ASYNC_OP_SCHEDULE_NEXT_PENDING_FN}($1::int) AS result`,
    [staleThresholdSeconds],
  );
  return res.rows[0].result;
}
