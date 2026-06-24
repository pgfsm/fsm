import { getLogger } from "@logtape/logtape";
import type { DbConfig, FsmStartupConfig, VerifiedFsmModule } from "./bootstrap-fsm-modules.ts";

const logger = getLogger(["@pgfsm/worker", "dispatcher"]);
import { bootstrapFsmModules } from "./bootstrap-fsm-modules.ts";
import { startFSMWorkerWithDBLock } from "./fsmworker.ts";
import { archiveMessage, readMessage } from "@pgfsm/db";

const DISPATCH_QUEUE = "master_worker_dispatch_queue";
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

/**
 * FSM dispatch daemon (KB-001 §3.1 / §5.1).
 *
 * Replaces the previous "spawn one `Deno.Command` child process per dispatch
 * message" model — which made connections/processes scale with the number of
 * live instances — with a bounded standing fleet:
 *
 *   - one shared pg Pool (from bootstrap) for every instance it drives;
 *   - a semaphore caps concurrent instances at `maxConcurrency`;
 *   - each instance is leased in-process via `startFSMWorkerWithDBLock`
 *     (atomic `lock_fsm_instance`), so connections scale with fleet size, not
 *     instance count;
 *   - the pg LISTEN stop signal aborts the matching instance's worker;
 *   - on shutdown all in-flight workers are aborted and drained before the
 *     pool closes.
 */
export async function runFsmDispatchDaemon(
  dbConfig: DbConfig,
  fsmConfig: FsmStartupConfig,
  options?: { signal?: AbortSignal; visibilityTimeout?: number; maxConcurrency?: number },
): Promise<void> {
  const signal = options?.signal;
  const vt = options?.visibilityTimeout ?? DEFAULT_VT;
  const maxConcurrency = options?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;

  const activeWorkers = new Map<string, ActiveWorker>();

  const { pool, verifiedFsmModules } = await bootstrapFsmModules(dbConfig, fsmConfig, {
    // pg_notify("fsm_worker_stop", <instance_id>) → abort just that worker.
    onWorkerStop: (queueName) => {
      activeWorkers.get(queueName)?.controller.abort();
    },
  });

  const deps = { db: pool, useSupabase: false };
  const sem = new Semaphore(maxConcurrency);

  // Cascade a daemon shutdown to every in-flight worker so blocked `acquire()`
  // calls unblock and the loop can exit promptly.
  signal?.addEventListener("abort", () => {
    for (const { controller } of activeWorkers.values()) {
      controller.abort();
    }
  });

  logger.info("Dispatcher ready. Polling {queue} (maxConcurrency={maxConcurrency}, vt={vt}s)", { queue: DISPATCH_QUEUE, maxConcurrency, vt });

  while (!signal?.aborted) {
    // Backpressure: don't dequeue work we have no slot to run.
    await sem.acquire();
    if (signal?.aborted) {
      sem.release();
      break;
    }

    const messages = await readMessage(deps, DISPATCH_QUEUE, vt);

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
      await archiveMessage(deps, DISPATCH_QUEUE, Number(msg.msg_id));
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

    await archiveMessage(deps, DISPATCH_QUEUE, Number(msg.msg_id));
    logger.info("Leased instance {instanceId} ({fsmName}@{fsmVersion})", { instanceId, fsmName, fsmVersion });
  }

  // Graceful drain: abort any stragglers and wait for slots to free.
  for (const { controller } of activeWorkers.values()) {
    controller.abort();
  }
  while (activeWorkers.size > 0) {
    await sleep(DRAIN_POLL_MS);
  }

  await pool.end();
  logger.info("Dispatcher stopped");
}
