import { getLogger } from "@logtape/logtape";
import { Pool } from "pg";
import type { PoolConfig } from "pg";
import type { DbConfig, FsmStartupConfig } from "./type.ts";
import type { FsmPluginValidationResult } from "@pgfsm/compiler";
import { validateSyncOperationFromFolders } from "@pgfsm/compiler";
import type { FsmModule } from "@pgfsm/db";
import {
  checkRegistryAndWorkingForAsyncActors,
  checkRegistryForAsyncActors,
  deregisterFsmlet,
  fsmletHeartbeat,
  registerFsmlet,
} from "@pgfsm/db";
import { startFSMWorkerWithDBLock } from "./fsmworker.ts";
import {
  claimScheduledForFsmlet,
  fsmletNotifyChannel,
} from "./fsm-scheduler.ts";

const logger = getLogger(["@pgfsm/fsmlet"]);

const DEFAULT_MAX_CONCURRENCY = 8;
const DRAIN_POLL_MS = 100;
const HEARTBEAT_INTERVAL_MS = 5_000;
// Fallback poll: catches any pg_notify missed after a LISTEN connection drop.
const FALLBACK_POLL_INTERVAL_MS = 30_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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

type ActiveWorker = { controller: AbortController };

export type FsmletOptions = {
  signal?: AbortSignal;
  maxConcurrency?: number;
  asyncOperationVerificationMode?: string; // "none" | "checkReistry" | "checkRegistryAndWorking" default: "checkRegistryAndWorking"
  /** Called when a fsm_worker_stop pg_notify fires, after the fsmlet's own abort. */
  onWorkerStop?: (instanceId: string) => void;
  /**
   * Stable identity for this fsmlet node. If omitted a random UUID is generated
   * each startup. Pass a fixed value (e.g. from FSMLET_ID env var) so the
   * scheduler recognises restarts as the same node.
   */
  fsmletId?: string;
};

export type FsmletHandle = {
  pool: Pool | null;
  verifiedFsmWithAsyncOps: FsmPluginValidationResult[];
  fsmletId: string;
  /** Resolves when the fsmlet exits cleanly. Does NOT close the pool. */
  daemon: Promise<void>;
  getActiveWorkerIds: () => string[];
};

/**
 * FSM fsmlet — node agent (kubelet equivalent).
 *
 * On startup:
 *   1. validateSyncOperationFromFolders FSM modules.
 *   2. based on asyncOperationVerificationMode, verifies asyncOperationActors in the FSM modules.
 *   3. Registers itself with valid FSM modules in fsm_workerlet.
 *   4. Opens a dedicated LISTEN connection for two channels:
 *        fsm_fsmlet_work_<id>  — scheduler routed work here
 *        fsm_worker_stop       — abort a specific running worker
 *   5. On each 'fsm_fsmlet_work' notify: calls claim_scheduled_for_fsmlet()
 *      which claims and deletes the row atomically, then starts the FSM worker.
 *   6. Sends heartbeats every 5 s so the scheduler can score this node.
 *   7. Fallback poll every 30 s to catch missed notifications.
 *
 * Returns immediately with a handle; the fsmlet runs in the background.
 * The caller owns the pool and must close it after `daemon` resolves.
 */
export async function startFsmlet(
  dbConfig: DbConfig,
  fsmConfig: FsmStartupConfig,
  options?: FsmletOptions,
): Promise<FsmletHandle> {
  const signal = options?.signal;
  const maxConcurrency = options?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const fsmletId = options?.fsmletId ?? crypto.randomUUID();

  const asyncOperationVerificationMode =
    options?.asyncOperationVerificationMode ?? "none";
  let pool: Pool | null = null;
  let verifiedFsmWithAsyncOps: FsmPluginValidationResult[] = [];
  let daemon: Promise<void> = Promise.resolve();

  const activeWorkers = new Map<string, ActiveWorker>();

  if (fsmConfig) {
    // Step 1: validateSyncOperationFromFolders FSM modules.
    const outputFsm = fsmConfig.fsm
      ? await validateSyncOperationFromFolders(
        fsmConfig.fsm.folderPath,
        "fsm",
        fsmConfig.fsm.skipDirs ?? [],
        [],
      )
      : [];
    const verifiedFsm = outputFsm.filter((m) => m.isFsmModuleVerified === true);

    if (verifiedFsm.length === 0) {
      logger.warning(
        "Fsmlet {fsmletId}: no verified FSM modules found in {folderPath}",
        {
          fsmletId,
          folderPath: fsmConfig?.fsm?.folderPath,
        },
      );
    } else {
      pool = new Pool(dbConfig);
      const client = await pool.connect();
      client.release();
      const deps = { db: pool, useSupabase: false };

      // step 2. Based on asyncOperationVerificationMode, verifies asyncOperationActors in the FSM modules.
      if (asyncOperationVerificationMode === "checkRegistry") {
        for (const fsmModule of verifiedFsm) {
          const asyncActors = fsmModule.asyncOperationActors ?? [];
          const result = await checkRegistryForAsyncActors(
            deps,
            asyncActors,
            fsmModule.fsmName,
            fsmModule.fsmVersion,
          );
          fsmModule.isAsyncOperationActorsVerified = result.all_registered;
        }
      } else if (
        asyncOperationVerificationMode === "checkRegistryAndWorking"
      ) {
        for (const fsmModule of verifiedFsm) {
          const asyncActors = fsmModule.asyncOperationActors ?? [];
          const registryResult = await checkRegistryForAsyncActors(
            deps,
            asyncActors,
            fsmModule.fsmName,
            fsmModule.fsmVersion,
          );
          const workingResult = await checkRegistryAndWorkingForAsyncActors(
            deps,
            asyncActors,
            fsmModule.fsmName,
            fsmModule.fsmVersion,
          );
          fsmModule.isAsyncOperationActorsVerified =
            registryResult.all_registered && workingResult.all_working;
        }
      } else {
        logger.info(
          "Fsmlet {fsmletId}: asyncOperationVerificationMode is set to 'none', skipping async operation actors verification",
          {
            fsmletId,
          },
        );
        for (const fsmModule of verifiedFsm) {
          fsmModule.isAsyncOperationActorsVerified = true;
        }
      }

      verifiedFsmWithAsyncOps = verifiedFsm.filter((m) =>
        m.isAsyncOperationActorsVerified === true
      );
      if (verifiedFsmWithAsyncOps.length === 0) {
        logger.warning(
          "Fsmlet {fsmletId}: no verified FSM modules with async operation actors found in {folderPath}",
          {
            fsmletId,
            folderPath: fsmConfig?.fsm?.folderPath,
          },
        );
      }

      // Step 3: Registers itself with valid FSM modules in fsm_workerlet.
      const verifiedFsmWithAsyncOpsToBeRegistered: FsmModule[] =
        verifiedFsmWithAsyncOps.map((m) => ({
          fsmName: m.fsmName,
          fsmVersion: m.fsmVersion,
        }));
      await registerFsmlet(
        deps,
        fsmletId,
        verifiedFsmWithAsyncOpsToBeRegistered,
        maxConcurrency,
      );
      logger.info(
        "Fsmlet {fsmletId} registered ({count} modules, maxConcurrency={max})",
        {
          fsmletId,
          count: verifiedFsmWithAsyncOpsToBeRegistered.length,
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

        const module = verifiedFsmWithAsyncOps.find(
          (m: FsmPluginValidationResult) =>
            m.fsmName === fsmName && m.fsmVersion === fsmVersion,
        );

        if (!module) {
          logger.warning(
            "Fsmlet {fsmletId}: no verified module for {fsmName}@{fsmVersion} (instance {instanceId})",
            { fsmletId, fsmName, fsmVersion, instanceId },
          );
          sem.release();
          return;
        }

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
          module,
          false,
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

      // Step 4: dedicated LISTEN connection for work notifications and stop signals.
      const listenClient = await pool.connect();
      const workChannel = fsmletNotifyChannel(fsmletId);
      await listenClient.query(`LISTEN "${workChannel}"`);
      await listenClient.query(`LISTEN fsm_worker_stop`);

      listenClient.on("notification", (msg) => {
        if (msg.channel === workChannel) {
          // Step 5: on each 'fsm_fsmlet_work' notify, call claimScheduledForFsmlet() atomically then start the FSM worker.
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

      // Step 6 & 7: heartbeat + fallback poll loop (the daemon's main blocking task).
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

      daemon = runHeartbeatAndFallback().then(async () => {
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
    }
  }

  return {
    pool,
    verifiedFsmWithAsyncOps,
    fsmletId,
    daemon,
    getActiveWorkerIds: () => [...activeWorkers.keys()],
  };
}

/**
 * Standalone entry point for CLI use. Starts the fsmlet, awaits it, then
 * closes the pool. Prefer `startFsmlet` when embedding the fsmlet inside
 * another process so the caller controls pool lifecycle.
 */
export async function runFsmlet(
  dbConfig: DbConfig,
  fsmConfig: FsmStartupConfig,
  options?: FsmletOptions,
): Promise<void> {
  const { pool, daemon } = await startFsmlet(dbConfig, fsmConfig, options);
  await daemon;
  if (pool) {
    await pool.end();
    logger.info("Pool closed");
  }
}
