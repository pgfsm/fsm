import { getLogger } from "@logtape/logtape";
import type { DbConfig, FsmStartupConfig, VerifiedFsmModule } from "./bootstrap-fsm-modules.ts";
import { pgListenerForWorkerStopEvent } from "./pg-listener-for-worker-stop-event.ts";

const logger = getLogger(["@pgfsm/worker", "dispatcher"]);
import { bootstrapFsmModules } from "./bootstrap-fsm-modules.ts";
import { startFSMWorkerWithDBLock } from "./fsmworker.ts";
import { archiveMessage, readMessage } from "@pgfsm/db";
import type { Pool } from "pg";

const DISPATCH_QUEUE_START = "master_worker_dispatch_queue_start";
const DISPATCH_QUEUE_RESUME = "master_worker_dispatch_queue_resume";
const DEFAULT_VT = 60;
const POLL_INTERVAL_MS = 1000;
const DEFAULT_MAX_CONCURRENCY = 8;
const DRAIN_POLL_MS = 100;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Counting semaphore used to bound the number of FSM instances this dispatcher
 * drives concurrently. This is the backpressure mechanism from KB-001 §3.1:
 * instead of one OS process per instance, a single standing daemon multiplexes
 * up to `maxConcurrency` instances over one shared pg Pool.
 */
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
      // Hand the permit directly to the next waiter — keeps the count balanced.
      next();
    } else {
      this.permits++;
    }
  }
}

type ActiveWorker = { controller: AbortController };

export type DaemonOptions = {
  signal?: AbortSignal;
  visibilityTimeout?: number;
  maxConcurrency?: number;
  /** Called when a fsm_worker_stop pg_notify fires, after the daemon's own abort. */
  onWorkerStop?: (instanceId: string) => void;
};

export type DaemonHandle = {
  pool: Pool;
  verifiedFsmModules: VerifiedFsmModule[];
  /** Resolves when the daemon exits cleanly. Does NOT close the pool. */
  daemon: Promise<void>;
  getActiveWorkerIds: () => string[];
};

/**
 * FSM dispatch daemon (KB-001 §3.1 / §5.1).
 *
 * Sets up the daemon (bootstraps modules, wires pg LISTEN, spawns actor
 * processes) and returns immediately with a handle. The caller owns the pool
 * and must close it after `daemon` resolves.
 *
 * Use `runFsmDispatchDaemon` for standalone CLI use where pool lifecycle is
 * managed automatically.
 */
export async function startFsmDispatchDaemon(
  dbConfig: DbConfig,
  fsmConfig: FsmStartupConfig,
  options?: DaemonOptions,
): Promise<DaemonHandle> {
  const signal = options?.signal;
  const vt = options?.visibilityTimeout ?? DEFAULT_VT;
  const maxConcurrency = options?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;

  const activeWorkers = new Map<string, ActiveWorker>();

  // Step 1: bootstrap FSM modules — loads verified FSM/sharedFsm/sharedPromise modules
  // and returns the shared pool.
  const { pool, verifiedFsmModules } = await bootstrapFsmModules(dbConfig, fsmConfig);

  // Step 2: spawn a separate Deno process for each internal (promise) actor across
  // all verified FSM modules. Each process owns its own poll loop and lifecycle,
  // keeping actor execution isolated from the orchestrator fleet (KB-001 §3.2).
  const cliScriptPath = new URL("./cli/index.ts", import.meta.url).pathname;

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
      logger.info("Spawned actor process for {src} (queue: {queue})", { src: actor.src, queue: queueName });
    }
  }

  const deps = { db: pool, useSupabase: false };
  const sem = new Semaphore(maxConcurrency);

  // Cascade a daemon shutdown to every in-flight worker so blocked `acquire()`
  // calls unblock and the loop can exit promptly. Actor processes are left
  // running — they manage their own lifecycle independently.
  signal?.addEventListener("abort", () => {
    for (const { controller } of activeWorkers.values()) {
      controller.abort();
    }
  });

  // Step 3: wire the pg LISTEN stop signal before starting loops so no stop
  // events are missed between setup and the first poll iteration.
  await pgListenerForWorkerStopEvent(pool, (instanceId) => {
    activeWorkers.get(instanceId)?.controller.abort();
    options?.onWorkerStop?.(instanceId);
  });
  logger.info("PG LISTEN active on channel: fsm_worker_stop");

  // Steps 4 & 5 share one semaphore and activeWorkers map so total concurrency
  // is bounded across both queues together.
  const runDispatchLoop = async (queue: string) => {
    logger.info("Polling {queue} (maxConcurrency={maxConcurrency}, vt={vt}s)", { queue, maxConcurrency, vt });

    while (!signal?.aborted) {
      // Backpressure: don't dequeue work we have no slot to run.
      await sem.acquire();
      if (signal?.aborted) {
        sem.release();
        break;
      }

      const messages = await readMessage(deps, queue, vt);

      if (messages.length === 0) {
        sem.release();
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const msg = messages[0];
      const instance = msg.message as Record<string, string>;
      const instanceId = instance["id"];
      const fsmName = instance["fsm_name"];
      const fsmVersion = instance["fsm_version"];

      // Already leased by this dispatcher — drop the duplicate dispatch message.
      if (activeWorkers.has(instanceId)) {
        await archiveMessage(deps, queue, Number(msg.msg_id));
        sem.release();
        continue;
      }

      const module = verifiedFsmModules.find(
        (m: VerifiedFsmModule) => m.fsmName === fsmName && m.fsmVersion === fsmVersion,
      );

      if (!module) {
        logger.warning("No verified module for {fsmName}@{fsmVersion} (instance {instanceId}). Message re-appears after vt={vt}s", { fsmName, fsmVersion, instanceId, vt });
        sem.release();
        continue;
      }

      const controller = new AbortController();
      activeWorkers.set(instanceId, { controller });

      // Fire-and-forget within the held slot; the slot is released when the
      // worker loop exits (terminal state, stop signal, or daemon shutdown).
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
            logger.warning("Worker for instance {instanceId} did not start: {message}", { instanceId, message: result.message });
          }
        })
        .catch((err) => {
          logger.error("Worker for instance {instanceId} crashed: {error}", { instanceId, error: err });
        })
        .finally(() => {
          activeWorkers.delete(instanceId);
          sem.release();
        });

      await archiveMessage(deps, queue, Number(msg.msg_id));
      logger.info("Leased instance {instanceId} ({fsmName}@{fsmVersion}) from {queue}", { instanceId, fsmName, fsmVersion, queue });
    }
  };

  // Step 4: poll master_worker_dispatch_queue_start — new FSM instances.
  // Step 5: poll master_worker_dispatch_queue_resume — instances resuming after an await.
  const daemon = Promise.all([
    runDispatchLoop(DISPATCH_QUEUE_START),
    runDispatchLoop(DISPATCH_QUEUE_RESUME),
  ]).then(async () => {
    // Graceful drain: abort any stragglers and wait for slots to free.
    for (const { controller } of activeWorkers.values()) {
      controller.abort();
    }
    while (activeWorkers.size > 0) {
      await sleep(DRAIN_POLL_MS);
    }
    logger.info("Dispatcher stopped");
  });

  return {
    pool,
    verifiedFsmModules,
    daemon,
    getActiveWorkerIds: () => [...activeWorkers.keys()],
  };
}

/**
 * Standalone daemon entry point for CLI use. Starts the daemon, awaits it,
 * then closes the pool. Prefer `startFsmDispatchDaemon` when embedding the
 * daemon inside another process (e.g. the API server) so the caller controls
 * pool lifecycle.
 */
export async function runFsmDispatchDaemon(
  dbConfig: DbConfig,
  fsmConfig: FsmStartupConfig,
  options?: DaemonOptions,
): Promise<void> {
  const { pool, daemon } = await startFsmDispatchDaemon(dbConfig, fsmConfig, options);
  await daemon;
  await pool.end();
  logger.info("Pool closed");
}
