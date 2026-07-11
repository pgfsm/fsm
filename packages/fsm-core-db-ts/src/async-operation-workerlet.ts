import { getLogger } from "@logtape/logtape";
import type { DBDeps } from "./custom-type.ts";
import { FSM_SCHEMA } from "./const.ts";

const logger = getLogger(["@pgfsm/db", "async-op-workerlet"]);

const ASYNC_OP_WORKERLET_TABLE = `${FSM_SCHEMA}.async_operation_workerlet`;
const CLAIM_SCHEDULED_FN =
  `${FSM_SCHEMA}.claim_scheduled_for_async_operation_workerlet`;

export type AsyncOperationSupportedOp = {
  async_operation_name: string;
  async_operation_version: string;
  parent_fsm_name: string;
  parent_fsm_version: string;
};

export type AsyncOpDispatchEntry = {
  async_operation_instance_and_async_operation_workerlet_id: string;
  async_operation_instance_id: string;
  async_operation_workerlet_id: string;
  async_operation_name: string;
  async_operation_version: string;
  async_operation_type: string;
  parent_fsm_name: string;
  parent_fsm_version: string;
  async_operation_language: string;
};

export function asyncOperationWorkerletNotifyChannel(
  workerletId: string,
): string {
  return `async_operation_workerlet_work_${workerletId}`;
}

export async function registerAsyncOperationWorkerlet(
  deps: DBDeps,
  workerletId: string,
  supportedOps: AsyncOperationSupportedOp[],
  maxConcurrency: number,
): Promise<void> {
  await deps.db.query(
    `INSERT INTO ${ASYNC_OP_WORKERLET_TABLE}
       (async_operation_workerlet_id, async_operation_workerlet_pid,
        supported_async_operations, max_pid_number)
     VALUES ($1::uuid, $1, $2::jsonb, $3)
     ON CONFLICT (async_operation_workerlet_id) DO UPDATE SET
       supported_async_operations = EXCLUDED.supported_async_operations,
       max_pid_number             = EXCLUDED.max_pid_number,
       last_heartbeat             = NOW()`,
    [workerletId, JSON.stringify(supportedOps), maxConcurrency],
  );
  logger.info(
    "AsyncOperationWorkerlet {workerletId} registered ({count} ops, maxConcurrency={max})",
    { workerletId, count: supportedOps.length, max: maxConcurrency },
  );
}

export async function asyncOperationWorkerletHeartbeat(
  deps: DBDeps,
  workerletId: string,
  activePidNumber: number,
): Promise<void> {
  await deps.db.query(
    `UPDATE ${ASYNC_OP_WORKERLET_TABLE}
     SET last_heartbeat = NOW(), active_pid_number = $2
     WHERE async_operation_workerlet_id = $1::uuid`,
    [workerletId, activePidNumber],
  );
}

export async function deregisterAsyncOperationWorkerlet(
  deps: DBDeps,
  workerletId: string,
): Promise<void> {
  await deps.db.query(
    `DELETE FROM ${ASYNC_OP_WORKERLET_TABLE}
     WHERE async_operation_workerlet_id = $1::uuid`,
    [workerletId],
  );
  logger.info("AsyncOperationWorkerlet {workerletId} deregistered", {
    workerletId,
  });
}

/**
 * Thin wrapper around fsm_core.claim_scheduled_for_async_operation_workerlet().
 * Atomically claims and deletes one 'scheduled' dispatch entry assigned to this
 * workerlet. Returns null if nothing is waiting (spurious notify or already
 * claimed by another coroutine on the same workerlet).
 */
export async function claimScheduledForAsyncOperationWorkerlet(
  deps: DBDeps,
  workerletId: string,
): Promise<AsyncOpDispatchEntry | null> {
  const res = await deps.db.query<{ result: AsyncOpDispatchEntry | null }>(
    `SELECT ${CLAIM_SCHEDULED_FN}($1::uuid) AS result`,
    [workerletId],
  );
  return res.rows[0]?.result ?? null;
}
