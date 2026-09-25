import { getLogger } from "@logtape/logtape";
import { Pool } from "pg";
import type {
  ActiveWorker,
  DbConfig,
  FsmJsonFileConfig,
  FsmletHandle,
  FsmletOptions,
  FsmStartupConfig,
} from "./type.ts";
import type { FsmPluginValidationResult } from "@pgfsm/compiler";
import { discoverVerifiedFsmModules } from "./sync-operation-registrations.ts";
import type { AsyncActor, FsmModule } from "@pgfsm/db";
import {
  checkRegistryAndWorkingForAsyncActors,
  checkRegistryForAsyncActors,
  deregisterFsmlet,
  fsmletHeartbeat,
  loadFsmFromJson,
  registerFsmlet,
} from "@pgfsm/db";
import { startFSMWorkerWithDBLock } from "./fsmworker.ts";
import { claimScheduledForFsmlet, fsmletNotifyChannel } from "@pgfsm/db";

const logger = getLogger(["@pgfsm/fsmlet"]);

const DEFAULT_MAX_CONCURRENCY = 8;

// check_registry_for_async_actors/check_registry_and_working_for_async_actors...
// (packages/database-src/supabase/schemas/25_async_operation_worker_v1/) read
// each actor's own version from a `fsmVersion` JSON key and match it against
// async_operation_version — despite the name, this is the actor's
// asyncOperationVersion, not the parent FSM's version (already passed
// separately as those functions' own fsmVersion argument). ActorReference has
// no `fsmVersion` field at all, so passing it straight through left that key
// undefined on every actor, meaning both checks always reported every actor
// as unregistered (see #169).
function toAsyncActors(
  actors: { src: string; asyncOperationVersion?: string }[],
): AsyncActor[] {
  return actors.map((actor) => ({
    src: actor.src,
    fsmVersion: actor.asyncOperationVersion ?? "",
  }));
}
const DRAIN_POLL_MS = 100;
const HEARTBEAT_INTERVAL_MS = 5_000;
// Fallback poll: catches any pg_notify missed after a LISTEN connection drop.
const FALLBACK_POLL_INTERVAL_MS = 30_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const isFsmJsonFileConfig = (
  fsm: NonNullable<FsmStartupConfig["fsm"]>,
): fsm is FsmJsonFileConfig => "fsmJsonPath" in fsm;

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
 * On startup:
 *   1. discoverVerifiedFsmModules FSM modules from the compiler-generated
 *      sync-worker output (see sync-operation-registrations.ts, #340).
 *   2. based on asyncOperationVerificationMode, verifies asyncOperationActors in the FSM modules.
 *   3. Load each verified FSM module into the database.
 *   4. Registers itself with valid FSM modules in fsm_workerlet.
 *   5. Opens a dedicated LISTEN connection for two channels:
 *        fsm_fsmlet_work_<id>  — scheduler routed work here
 *        fsm_worker_stop       — abort a specific running worker
 *   6. On each 'fsm_fsmlet_work' notify: calls claim_scheduled_for_fsmlet()
 *      which claims and deletes the row atomically, then starts the FSM worker.
 *   7. Sends heartbeats every 5 s so the scheduler can score this node.
 *   8. Fallback poll every 30 s to catch missed notifications.
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
  logger.info(
    "Fsmlet {fsmletId} starting (maxConcurrency={max}, asyncOperationVerificationMode={mode})",
    {
      fsmletId,
      max: maxConcurrency,
      mode: asyncOperationVerificationMode,
    },
  );
  if (fsmConfig) {
    // Step 1: discover this fsmlet's FSM modules straight from the
    // compiler-generated sync-worker output — no per-instance dynamic-import
    // validation against the source FSM tree any more (see
    // sync-operation-registrations.ts, #340). Single fsm.json mode narrows to
    // just that one <fsmName>/<fsmVersion>; folder mode takes every group the
    // aggregate registry has, minus skipDirs (matched against fsmName, same
    // as the old source-tree walk skipped top-level plugin-root folders).
    const fsmSource = fsmConfig.fsm
      ? isFsmJsonFileConfig(fsmConfig.fsm)
        ? fsmConfig.fsm.fsmJsonPath
        : fsmConfig.fsm.folderPath
      : undefined;
    const outputFsm = fsmConfig.fsm
      ? isFsmJsonFileConfig(fsmConfig.fsm)
        ? await discoverVerifiedFsmModules({
          mode: "single",
          fsmName: fsmConfig.fsm.fsmName,
          fsmVersion: fsmConfig.fsm.fsmVersion,
        })
        : await discoverVerifiedFsmModules({
          mode: "all",
          skipFsmNames: fsmConfig.fsm.skipDirs ?? [],
        })
      : [];
    const verifiedFsm = outputFsm.filter((m) => m.isFsmModuleVerified === true);

    if (verifiedFsm.length === 0) {
      throw new Error(
        `Fsmlet ${fsmletId}: no verified FSM modules found in ${fsmSource}. Fix plugin validation errors and retry.`,
      );
    } else {
      pool = new Pool(dbConfig);
      const client = await pool.connect();
      client.release();
      const deps = { db: pool, useSupabase: false };

      // step 2. Based on asyncOperationVerificationMode, verifies asyncOperationActors in the FSM modules.
      if (asyncOperationVerificationMode === "checkRegistry") {
        for (const fsmModule of verifiedFsm) {
          const asyncActors = toAsyncActors(
            fsmModule.asyncOperationActors ?? [],
          );
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
          const asyncActors = toAsyncActors(
            fsmModule.asyncOperationActors ?? [],
          );
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
        throw new Error(
          `Fsmlet ${fsmletId}: no FSM modules passed async actor verification (mode: ${asyncOperationVerificationMode}) in ${fsmSource}. Ensure async actors are registered and retry.`,
        );
      }

      // Step 3: Load each verified FSM module into the database.
      for (const fsmModule of verifiedFsmWithAsyncOps) {
        try {
          await loadFsmFromJson(
            deps,
            fsmModule.fsmJsonConfigData,
            null,
            fsmModule.fsmName,
            fsmModule.fsmVersion,
          );
          logger.info(
            "Fsmlet {fsmletId}: loaded {fsmName}@{fsmVersion} into DB",
            {
              fsmletId,
              fsmName: fsmModule.fsmName,
              fsmVersion: fsmModule.fsmVersion,
            },
          );
        } catch (err) {
          logger.error(
            "Fsmlet {fsmletId}: failed to load {fsmName}@{fsmVersion}: {error}",
            {
              fsmletId,
              fsmName: fsmModule.fsmName,
              fsmVersion: fsmModule.fsmVersion,
              error: err,
            },
          );
          throw err;
        }
      }

      // Step 4: Registers itself with valid FSM modules in fsm_workerlet.
      const verifiedFsmWithAsyncOpsToBeRegistered: FsmModule[] =
        verifiedFsmWithAsyncOps.map((m) => ({
          fsm_name: m.fsmName,
          fsm_version: m.fsmVersion,
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

      // Step 5: dedicated LISTEN connection for work notifications and stop signals.
      const listenClient = await pool.connect();
      const workChannel = fsmletNotifyChannel(fsmletId);
      await listenClient.query(`LISTEN "${workChannel}"`);
      await listenClient.query(`LISTEN fsm_worker_stop`);

      listenClient.on("notification", (msg) => {
        if (msg.channel === workChannel) {
          // Step 6: on each 'fsm_fsmlet_work' notify, call claimScheduledForFsmlet() atomically then start the FSM worker.
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

      // Step 7 & 8: heartbeat + fallback poll loop (the daemon's main blocking task).
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
