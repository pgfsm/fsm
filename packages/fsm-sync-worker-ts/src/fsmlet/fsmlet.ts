import { getLogger } from "@logtape/logtape";
import { Pool } from "pg";
import type {
  ActiveWorker,
  DbConfig,
  FsmletHandle,
  FsmletOptions,
  SyncOperationRegistration,
} from "./type.ts";
import type { FsmModule } from "@pgfsm/db";
import {
  claimScheduledForFsmlet,
  deregisterFsmlet,
  fsmletHeartbeat,
  fsmletNotifyChannel,
  registerFsmlet,
} from "@pgfsm/db";
import { startFSMWorkerWithDBLock } from "./fsmworker.ts";

const logger = getLogger(["@pgfsm/fsmlet"]);

const DEFAULT_MAX_CONCURRENCY = 8;
const DRAIN_POLL_MS = 100;
const HEARTBEAT_INTERVAL_MS = 5_000;
// Fallback poll: catches any pg_notify missed after a LISTEN connection drop.
const FALLBACK_POLL_INTERVAL_MS = 30_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Every distinct `<fsmName>/<fsmVersion>` pair present in `registrations`, first-seen order. */
function distinctFsmModules(
  registrations: SyncOperationRegistration[],
): FsmModule[] {
  const seen = new Set<string>();
  const modules: FsmModule[] = [];
  for (const r of registrations) {
    const key = `${r.fsmName}/${r.fsmVersion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    modules.push({ fsm_name: r.fsmName, fsm_version: r.fsmVersion });
  }
  return modules;
}

class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }
}

/**
 * FSM fsmlet — node agent (kubelet equivalent).
 *
 * FSM modules served by this fsmlet come directly from the
 * `syncOperationRegistrations` the caller passes in — normally the
 * compiler-generated `SYNC_OPERATION_REGISTRATIONS` aggregate registry (see
 * fsm-compiler-ts #338), imported by the caller and handed straight through —
 * every `<fsmName>/<fsmVersion>` in it is this fsmlet's full workload. There
 * is deliberately no discovery/validation pass, no async-operation-actor
 * registry verification (assumed unnecessary for now — a project's FSMs and
 * their actors are trusted once compiled), and no per-fsmlet
 * `loadFsmFromJson` call — FSMs must already be loaded into the database by
 * whatever separately ran that step (see fsm-sync-worker-ts #340).
 *
 * On startup:
 *   1. Registers itself with every FSM module in `syncOperationRegistrations`
 *      in fsm_workerlet.
 *   2. Opens a dedicated LISTEN connection for two channels:
 *        fsm_fsmlet_work_<id>  — scheduler routed work here
 *        fsm_worker_stop       — abort a specific running worker
 *   3. On each 'fsm_fsmlet_work' notify: calls claim_scheduled_for_fsmlet()
 *      which claims and deletes the row atomically, then starts the FSM
 *      worker with the sub-array of `syncOperationRegistrations` matching
 *      that claimed entry's `fsm_name`/`fsm_version`.
 *   4. Sends heartbeats every 5 s so the scheduler can score this node.
 *   5. Fallback poll every 30 s to catch missed notifications.
 *
 * Returns immediately with a handle; the fsmlet runs in the background.
 * The caller owns the pool and must close it after `daemon` resolves.
 */
export async function startFsmlet(
  dbConfig: DbConfig,
  syncOperationRegistrations: SyncOperationRegistration[],
  options?: FsmletOptions,
): Promise<FsmletHandle> {
  const signal = options?.signal;
  const maxConcurrency = options?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const fsmletId = options?.fsmletId ?? crypto.randomUUID();

  const activeWorkers = new Map<string, ActiveWorker>();
  logger.info(
    "Fsmlet {fsmletId} starting (maxConcurrency={max})",
    { fsmletId, max: maxConcurrency },
  );

  const registeredFsmModules = distinctFsmModules(syncOperationRegistrations);
  if (registeredFsmModules.length === 0) {
    throw new Error(
      `Fsmlet ${fsmletId}: no FSM modules found in the aggregate sync-operation registry.`,
    );
  }

  const pool = new Pool(dbConfig);
  const client = await pool.connect();
  client.release();
  const deps = { db: pool, useSupabase: false };

  // Step 1: Registers itself with every FSM module in fsm_workerlet.
  await registerFsmlet(deps, fsmletId, registeredFsmModules, maxConcurrency);
  logger.info(
    "Fsmlet {fsmletId} registered ({count} modules, maxConcurrency={max})",
    {
      fsmletId,
      count: registeredFsmModules.length,
      max: maxConcurrency,
    },
  );

  const sem = new Semaphore(maxConcurrency);

  signal?.addEventListener("abort", () => {
    for (const { controller } of activeWorkers.values()) {
      controller.abort();
    }
  });

  // Start a worker for one claimed dispatch entry.
  // Fire-and-forget — called from the LISTEN handler and fallback poll.
  const processNextWork = async () => {
    await sem.acquire();
    if (signal?.aborted) {
      sem.release();
      return;
    }

    const entry = await claimScheduledForFsmlet(deps, fsmletId);
    if (!entry) {
      sem.release();
      return;
    }

    const {
      fsm_instance_id: instanceId,
      fsm_name: fsmName,
      fsm_version: fsmVersion,
    } = entry;

    if (activeWorkers.has(instanceId)) {
      // Already running on this fsmlet — duplicate dispatch, ignore.
      sem.release();
      return;
    }

    const instanceSyncOperationRegistrations = syncOperationRegistrations
      .filter(
        (r) => r.fsmName === fsmName && r.fsmVersion === fsmVersion,
      );

    const controller = new AbortController();
    activeWorkers.set(instanceId, { controller });
    logger.info(
      "Fsmlet {fsmletId}: starting worker for {instanceId} ({fsmName}@{fsmVersion})",
      {
        fsmletId,
        instanceId,
        fsmName,
        fsmVersion,
      },
    );

    startFSMWorkerWithDBLock(
      deps,
      instanceId,
      fsmName,
      fsmVersion,
      instanceSyncOperationRegistrations,
      controller.signal,
    )
      .then((result) => {
        if (result.status === "fail") {
          logger.warning(
            "Worker for {instanceId} did not start: {message}",
            {
              instanceId,
              message: result.message,
            },
          );
        }
      })
      .catch((err) => {
        logger.error("Worker for {instanceId} crashed: {error}", {
          instanceId,
          error: err,
        });
      })
      .finally(() => {
        activeWorkers.delete(instanceId);
        sem.release();
      });
  };

  // Step 2: dedicated LISTEN connection for work notifications and stop signals.
  const listenClient = await pool.connect();
  const workChannel = fsmletNotifyChannel(fsmletId);
  await listenClient.query(`LISTEN "${workChannel}"`);
  await listenClient.query(`LISTEN fsm_worker_stop`);

  listenClient.on("notification", (msg) => {
    if (msg.channel === workChannel) {
      // Step 3: on each 'fsm_fsmlet_work' notify, call claimScheduledForFsmlet() atomically then start the FSM worker.
      processNextWork().catch((err) =>
        logger.error("Fsmlet {fsmletId}: processNextWork error: {error}", {
          fsmletId,
          error: err,
        })
      );
    }
    if (msg.channel === "fsm_worker_stop" && msg.payload) {
      activeWorkers.get(msg.payload)?.controller.abort();
      options?.onWorkerStop?.(msg.payload);
    }
  });

  logger.info(
    "Fsmlet {fsmletId}: LISTEN active on {workChannel} + fsm_worker_stop",
    {
      fsmletId,
      workChannel,
    },
  );

  // Step 4 & 5: heartbeat + fallback poll loop (the daemon's main blocking task).
  const runHeartbeatAndFallback = async () => {
    let ticksSinceLastFallback = 0;
    const fallbackEveryNHeartbeats = Math.ceil(
      FALLBACK_POLL_INTERVAL_MS / HEARTBEAT_INTERVAL_MS,
    );

    while (!signal?.aborted) {
      await sleep(HEARTBEAT_INTERVAL_MS);
      if (signal?.aborted) break;

      try {
        await fsmletHeartbeat(deps, fsmletId, activeWorkers.size);
      } catch (err) {
        logger.warning("Fsmlet {fsmletId}: heartbeat failed: {error}", {
          fsmletId,
          error: err,
        });
      }

      ticksSinceLastFallback++;
      if (ticksSinceLastFallback >= fallbackEveryNHeartbeats) {
        ticksSinceLastFallback = 0;
        processNextWork().catch((err) =>
          logger.warning(
            "Fsmlet {fsmletId}: fallback poll error: {error}",
            {
              fsmletId,
              error: err,
            },
          )
        );
      }
    }
  };

  const daemon = runHeartbeatAndFallback().then(async () => {
    // Graceful drain: abort stragglers and wait for all workers to exit.
    for (const { controller } of activeWorkers.values()) {
      controller.abort();
    }
    while (activeWorkers.size > 0) {
      await sleep(DRAIN_POLL_MS);
    }
    listenClient.release();
    await deregisterFsmlet(deps, fsmletId);
    logger.info("Fsmlet {fsmletId} stopped", { fsmletId });
  });

  // Drain any work that was scheduled before this fsmlet's LISTEN was active.
  processNextWork().catch((err) =>
    logger.warning("Fsmlet {fsmletId}: initial work check error: {error}", {
      fsmletId,
      error: err,
    })
  );

  return {
    pool,
    registeredFsmModules,
    fsmletId,
    daemon,
    getActiveWorkerIds: () => [...activeWorkers.keys()],
  };
}

/**
 * Standalone entry point for CLI/script use. Starts the fsmlet, awaits it,
 * then closes the pool. Prefer `startFsmlet` when embedding the fsmlet
 * inside another process so the caller controls pool lifecycle.
 */
export async function runFsmlet(
  dbConfig: DbConfig,
  syncOperationRegistrations: SyncOperationRegistration[],
  options?: FsmletOptions,
): Promise<void> {
  const { pool, daemon } = await startFsmlet(
    dbConfig,
    syncOperationRegistrations,
    options,
  );
  await daemon;
  if (pool) {
    await pool.end();
    logger.info("Pool closed");
  }
}
