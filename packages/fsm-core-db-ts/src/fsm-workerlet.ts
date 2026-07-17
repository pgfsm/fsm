import { getLogger } from "@logtape/logtape";
import type { DBDeps } from "./custom-type.ts";
import { FSM_SCHEMA } from "./const.ts";

const logger = getLogger(["@pgfsm/db", "workerlet"]);

const FSM_WORKERLET_TABLE = `${FSM_SCHEMA}.fsm_workerlet`;
const SCHEDULE_NEXT_PENDING_FN = `${FSM_SCHEMA}.schedule_next_pending`;
const CLAIM_SCHEDULED_FOR_FSMLET_FN =
  `${FSM_SCHEMA}.claim_scheduled_for_fsmlet`;

export type FsmModule = { fsm_name: string; fsm_version: string };

export function fsmletNotifyChannel(fsmletId: string): string {
  return `fsm_fsmlet_work_${fsmletId}`;
}

export type FsmletNode = {
  fsm_workerlet_id: string;
  fsm_modules: FsmModule[];
  max_concurrency: number;
  active_workers: number;
  last_heartbeat: Date;
};

export type FsmDispatchEntry = {
  fsm_instance_and_fsm_workerlet_id: string;
  fsm_instance_id: string;
  fsm_name: string;
  fsm_version: string;
  dispatch_type: string;
};

/**
 * Thin wrapper around fsm_core.schedule_next_pending().
 * All scheduling logic (claim, filter+score fsmlets, assign, notify) runs
 * inside the PG function in a single transaction.
 * Returns true if an entry was scheduled, false if queue is empty or no
 * capable fsmlet is available.
 */
export async function scheduleNextPending(
  deps: DBDeps,
  staleThresholdSeconds = 30,
): Promise<boolean> {
  const res = await deps.db.query<{ schedule_next_pending: boolean }>(
    `SELECT ${SCHEDULE_NEXT_PENDING_FN}($1)`,
    [staleThresholdSeconds],
  );
  const scheduled = res.rows[0]?.schedule_next_pending ?? false;
  if (scheduled) {
    logger.info("schedule_next_pending: entry scheduled");
  }
  return scheduled;
}

/**
 * Thin wrapper around fsm_core.claim_scheduled_for_fsmlet().
 * Atomically claims one 'scheduled' dispatch entry assigned to this fsmlet
 * and deletes it. Returns null if nothing is waiting (spurious notify or
 * already claimed by another coroutine on the same fsmlet).
 */
export async function claimScheduledForFsmlet(
  deps: DBDeps,
  fsmletId: string,
): Promise<FsmDispatchEntry | null> {
  const res = await deps.db.query<{ result: FsmDispatchEntry | null }>(
    `SELECT ${CLAIM_SCHEDULED_FOR_FSMLET_FN}($1::uuid) AS result`,
    [fsmletId],
  );
  return res.rows[0]?.result ?? null;
}

export async function registerFsmlet(
  deps: DBDeps,
  fsmletId: string,
  fsmModules: FsmModule[],
  maxConcurrency: number,
): Promise<void> {
  await deps.db.query(
    `INSERT INTO ${FSM_WORKERLET_TABLE}
       (fsm_workerlet_id, fsm_workerlet_pid, fsm_modules, max_concurrency)
     VALUES ($1::uuid, $1, $2::jsonb, $3)
     ON CONFLICT (fsm_workerlet_id) DO UPDATE SET
       fsm_modules     = EXCLUDED.fsm_modules,
       max_concurrency = EXCLUDED.max_concurrency,
       last_heartbeat  = NOW()`,
    [fsmletId, JSON.stringify(fsmModules), maxConcurrency],
  );
  logger.info(
    "Fsmlet {fsmletId} registered (modules: {count}, maxConcurrency: {max})",
    { fsmletId, count: fsmModules.length, max: maxConcurrency },
  );
}

export async function fsmletHeartbeat(
  deps: DBDeps,
  fsmletId: string,
  activeWorkers: number,
): Promise<void> {
  await deps.db.query(
    `UPDATE ${FSM_WORKERLET_TABLE}
     SET last_heartbeat = NOW(), active_workers = $2
     WHERE fsm_workerlet_id = $1::uuid`,
    [fsmletId, activeWorkers],
  );
}

export async function deregisterFsmlet(
  deps: DBDeps,
  fsmletId: string,
): Promise<void> {
  await deps.db.query(
    `DELETE FROM ${FSM_WORKERLET_TABLE} WHERE fsm_workerlet_id = $1::uuid`,
    [fsmletId],
  );
  logger.info("Fsmlet {fsmletId} deregistered", { fsmletId });
}

export async function listActiveFsmlets(
  deps: DBDeps,
  staleThresholdSeconds = 30,
): Promise<FsmletNode[]> {
  const res = await deps.db.query<FsmletNode>(
    `SELECT fsm_workerlet_id, fsm_modules, max_concurrency, active_workers, last_heartbeat
     FROM ${FSM_WORKERLET_TABLE}
     WHERE last_heartbeat > NOW() - ($1 || ' seconds')::INTERVAL`,
    [staleThresholdSeconds],
  );
  return res.rows;
}
