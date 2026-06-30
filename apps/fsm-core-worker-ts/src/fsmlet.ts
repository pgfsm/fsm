import { getLogger } from "@logtape/logtape";
import type { DbConfig, FsmStartupConfig, VerifiedFsmModule } from "./bootstrap-fsm-modules.ts";
import { bootstrapFsmModules } from "./bootstrap-fsm-modules.ts";
import { startFSMWorkerWithDBLock } from "./fsmworker.ts";
import type { Pool } from "pg";
import {
  deregisterFsmlet,
  fsmletHeartbeat,
  registerFsmlet,
} from "./scheduler/fsmlet-registry.ts";
import type { FsmModule } from "./scheduler/fsmlet-registry.ts";
import {
  claimScheduledForFsmlet,
  fsmletNotifyChannel,
} from "./scheduler/fsm-dispatch-queue.ts";

const logger = getLogger(["@pgfsm/fsmlet"]);

const DEFAULT_MAX_CONCURRENCY = 8;
const DRAIN_POLL_MS = 100;
const HEARTBEAT_INTERVAL_MS = 5_000;
// Fallback poll: catches any pg_notify missed after a LISTEN connection drop.
const FALLBACK_POLL_INTERVAL_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  pool: Pool;
  verifiedFsmModules: VerifiedFsmModule[];
  fsmletId: string;
  /** Resolves when the fsmlet exits cleanly. Does NOT close the pool. */
  daemon: Promise<void>;
  getActiveWorkerIds: () => string[];
};

/**
 * FSM fsmlet — node agent (kubelet equivalent).
 *
 * On startup:
 *   1. Bootstraps FSM modules and creates the shared pool.
 *   2. Ensures fsm_daemon_node and fsm_dispatch_queue tables exist.
 *   3. Registers itself in fsm_daemon_node.
 *   4. Spawns actor processes for internal promise actors.
 *   5. Opens a dedicated LISTEN connection for two channels:
 *        fsm_fsmlet_work_<id>  — scheduler routed work here
 *        fsm_worker_stop       — abort a specific running worker
 *   6. On each 'fsm_fsmlet_work' notify: SELECT FOR UPDATE SKIP LOCKED
 *      from fsm_dispatch_queue, delete the row, start the FSM worker.
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

  const activeWorkers = new Map<string, ActiveWorker>();

  // Step 1: bootstrap FSM modules.
  const { pool, verifiedFsmModules } = await bootstrapFsmModules(dbConfig, fsmConfig);

  // Step 2: register this fsmlet in the node registry.
  const fsmModules: FsmModule[] = verifiedFsmModules.map((m) => ({
    fsmName: m.fsmName,
    fsmVersion: m.fsmVersion,
  }));
  await registerFsmlet(pool, fsmletId, fsmModules, maxConcurrency);
  logger.info("Fsmlet {fsmletId} registered ({count} modules, maxConcurrency={max})", {
    fsmletId,
    count: fsmModules.length,
    max: maxConcurrency,
  });

  // Step 4: spawn actor processes for internal (promise) actors.
  const cliScriptPath = new URL("./cli/worker.ts", import.meta.url).pathname;
  for (const fsm of verifiedFsmModules) {
    for (const actor of (fsm.internalActors ?? [])) {
      const queueName = `${fsm.fsmName}_${fsm.fsmVersion}_${actor.src}`;
      new Deno.Command(Deno.execPath(), {
        args: [
          "run", "--allow-all",
          cliScriptPath,
          "--command", "create-and-start-promise-worker",
          "--queue-name", queueName,
          "--fsm-name", actor.src,
          "--fsm-version", actor.fsmVersion ?? "",
          "--promise-type", actor.fsmType ?? "promise",
          "--fsm-folder-path", actor.fsmAbsFolderPath,
          "--db-url", dbConfig.connectionString,
        ],
        stdout: "inherit",
        stderr: "inherit",
      }).spawn();
      logger.info("Spawned actor process for {src} (queue: {queue})", {
        src: actor.src,
        queue: queueName,
      });
    }
  }

  const sem = new Semaphore(maxConcurrency);

  signal?.addEventListener("abort", () => {
    for (const { controller } of activeWorkers.values()) {
      controller.abort();
    }
  });

  const deps = { db: pool, useSupabase: false };

  // Start a worker for one claimed dispatch entry.
  // Fire-and-forget — called from the LISTEN handler and fallback poll.
  const processNextWork = async () => {
    await sem.acquire();
    if (signal?.aborted) {
      sem.release();
      return;
    }

    const entry = await claimScheduledForFsmlet(pool, fsmletId);
    if (!entry) {
      sem.release();
      return;
    }

    const { instance_id: instanceId, fsm_name: fsmName, fsm_version: fsmVersion } = entry;

    if (activeWorkers.has(instanceId)) {
      // Already running on this fsmlet — duplicate dispatch, ignore.
      sem.release();
      return;
    }

    const module = verifiedFsmModules.find(
      (m: VerifiedFsmModule) => m.fsmName === fsmName && m.fsmVersion === fsmVersion,
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
    logger.info("Fsmlet {fsmletId}: starting worker for {instanceId} ({fsmName}@{fsmVersion})", {
      fsmletId, instanceId, fsmName, fsmVersion,
    });

    startFSMWorkerWithDBLock(deps, instanceId, fsmName, fsmVersion, module, false, controller.signal)
      .then((result) => {
        if (result.status === "fail") {
          logger.warning("Worker for {instanceId} did not start: {message}", {
            instanceId,
            message: result.message,
          });
        }
      })
      .catch((err) => {
        logger.error("Worker for {instanceId} crashed: {error}", { instanceId, error: err });
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
      processNextWork().catch((err) =>
        logger.error("Fsmlet {fsmletId}: processNextWork error: {error}", { fsmletId, error: err })
      );
    }
    if (msg.channel === "fsm_worker_stop" && msg.payload) {
      activeWorkers.get(msg.payload)?.controller.abort();
      options?.onWorkerStop?.(msg.payload);
    }
  });

  logger.info("Fsmlet {fsmletId}: LISTEN active on {workChannel} + fsm_worker_stop", {
    fsmletId,
    workChannel,
  });

  // Step 6 & 7: heartbeat + fallback poll loop (the daemon's main blocking task).
  const runHeartbeatAndFallback = async () => {
    let ticksSinceLastFallback = 0;
    const fallbackEveryNHeartbeats = Math.ceil(FALLBACK_POLL_INTERVAL_MS / HEARTBEAT_INTERVAL_MS);

    while (!signal?.aborted) {
      await sleep(HEARTBEAT_INTERVAL_MS);
      if (signal?.aborted) break;

      try {
        await fsmletHeartbeat(pool, fsmletId, activeWorkers.size);
      } catch (err) {
        logger.warning("Fsmlet {fsmletId}: heartbeat failed: {error}", { fsmletId, error: err });
      }

      ticksSinceLastFallback++;
      if (ticksSinceLastFallback >= fallbackEveryNHeartbeats) {
        ticksSinceLastFallback = 0;
        processNextWork().catch((err) =>
          logger.warning("Fsmlet {fsmletId}: fallback poll error: {error}", { fsmletId, error: err })
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
    await deregisterFsmlet(pool, fsmletId);
    logger.info("Fsmlet {fsmletId} stopped", { fsmletId });
  });

  // Drain any work that was scheduled before this fsmlet's LISTEN was active.
  processNextWork().catch((err) =>
    logger.warning("Fsmlet {fsmletId}: initial work check error: {error}", { fsmletId, error: err })
  );

  return {
    pool,
    verifiedFsmModules,
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
  await pool.end();
  logger.info("Pool closed");
}
