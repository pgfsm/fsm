import { getLogger } from "@logtape/logtape";
import type { Pool } from "pg";

const logger = getLogger(["@pgfsm/fsmlet", "registry"]);

export type FsmModule = { fsmName: string; fsmVersion: string };

export type FsmletNode = {
  daemon_id: string;
  fsm_modules: FsmModule[];
  max_concurrency: number;
  active_workers: number;
  last_heartbeat: Date;
};

export async function registerFsmlet(
  pool: Pool,
  fsmletId: string,
  fsmModules: FsmModule[],
  maxConcurrency: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO fsm_core.fsm_daemon_node
       (daemon_id, fsm_modules, max_concurrency, active_workers, last_heartbeat)
     VALUES ($1, $2::jsonb, $3, 0, NOW())
     ON CONFLICT (daemon_id) DO UPDATE SET
       fsm_modules     = EXCLUDED.fsm_modules,
       max_concurrency = EXCLUDED.max_concurrency,
       last_heartbeat  = NOW()`,
    [fsmletId, JSON.stringify(fsmModules), maxConcurrency],
  );
  logger.info(
    "Fsmlet {fsmletId} registered (modules: {count}, maxConcurrency: {max})",
    {
      fsmletId,
      count: fsmModules.length,
      max: maxConcurrency,
    },
  );
}

export async function fsmletHeartbeat(
  pool: Pool,
  fsmletId: string,
  activeWorkers: number,
): Promise<void> {
  await pool.query(
    `UPDATE fsm_core.fsm_daemon_node
     SET last_heartbeat = NOW(), active_workers = $2
     WHERE daemon_id = $1`,
    [fsmletId, activeWorkers],
  );
}

export async function deregisterFsmlet(
  pool: Pool,
  fsmletId: string,
): Promise<void> {
  await pool.query(
    `DELETE FROM fsm_core.fsm_daemon_node WHERE daemon_id = $1`,
    [fsmletId],
  );
  logger.info("Fsmlet {fsmletId} deregistered", { fsmletId });
}

// Returns only fsmlets whose heartbeat arrived within staleThresholdSeconds.
// The scheduler uses this to filter out dead nodes before scoring.
export async function listActiveFsmlets(
  pool: Pool,
  staleThresholdSeconds = 30,
): Promise<FsmletNode[]> {
  const res = await pool.query<FsmletNode>(
    `SELECT daemon_id, fsm_modules, max_concurrency, active_workers, last_heartbeat
     FROM fsm_core.fsm_daemon_node
     WHERE last_heartbeat > NOW() - ($1 || ' seconds')::INTERVAL`,
    [staleThresholdSeconds],
  );
  return res.rows;
}
