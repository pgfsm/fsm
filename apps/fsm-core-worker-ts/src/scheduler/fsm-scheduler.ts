import { getLogger } from "@logtape/logtape";
import { Pool } from "pg";
import {
  scheduleNextPending,
  SCHEDULER_NOTIFY_CHANNEL,
} from "./fsm-dispatch-queue.ts";

const logger = getLogger(["@pgfsm/scheduler"]);

const DEFAULT_STALE_THRESHOLD_S = 30;
// Fallback poll interval — catches any pg_notify that was missed (e.g. after
// a LISTEN connection drop and reconnect).
const FALLBACK_POLL_INTERVAL_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type FsmSchedulerOptions = {
  signal?: AbortSignal;
  staleThresholdSeconds?: number;
};

/**
 * FSM Scheduler — control-plane routing process (kube-scheduler equivalent).
 *
 * Listens on the 'fsm_scheduler_work' pg_notify channel. When a dispatch
 * entry is enqueued, the notification fires a scheduling cycle which calls
 * fsm_core.schedule_next_pending() in a loop until the queue is empty or
 * no fsmlet has capacity. The PG function handles claim + filter/score +
 * assign + notify in a single transaction.
 *
 * A fallback poll runs every 30 s to catch any missed notifications.
 * Run this on the control plane alongside the API server.
 */
export async function runFsmScheduler(
  dbConfig: { connectionString: string; max?: number },
  options?: FsmSchedulerOptions,
): Promise<void> {
  const signal = options?.signal;
  const staleSecs = options?.staleThresholdSeconds ?? DEFAULT_STALE_THRESHOLD_S;

  const pool = new Pool(dbConfig);

  // One scheduling cycle: drain all pending entries until the queue is empty
  // or no fsmlet has capacity. Each call to scheduleNextPending delegates
  // entirely to fsm_core.schedule_next_pending() — no TypeScript-side
  // fsmlet selection or separate registry query needed.
  const runCycle = async () => {
    try {
      while (await scheduleNextPending(pool, staleSecs)) {
        // keep going until queue is empty or no capable fsmlet
      }
    } catch (err) {
      logger.error("Scheduler cycle error: {error}", { error: err });
    }
  };

  // Dedicated LISTEN connection — intentionally never released.
  const listenClient = await pool.connect();
  await listenClient.query(`LISTEN "${SCHEDULER_NOTIFY_CHANNEL}"`);
  listenClient.on("notification", (msg) => {
    if (msg.channel === SCHEDULER_NOTIFY_CHANNEL) {
      runCycle();
    }
  });

  logger.info("Scheduler listening on channel: {channel}", { channel: SCHEDULER_NOTIFY_CHANNEL });

  // Run an initial cycle in case entries were enqueued before this process started.
  await runCycle();

  // Fallback poll loop — also serves as the main blocking mechanism.
  while (!signal?.aborted) {
    await sleep(FALLBACK_POLL_INTERVAL_MS);
    if (signal?.aborted) break;
    await runCycle();
  }

  listenClient.release();
  await pool.end();
  logger.info("Scheduler stopped");
}
