// How the gateway learns that an invoke it is running should be cancelled
// because its FSM state exited (SPEC-012 (b), #538). The database archives
// the invoke's message (finish_async_operation_event_v2('cancelled'), from
// stop_invoked_async_operation_v2) and notifies fsm_async_operation_cancel
// with {queue_name, msg_id} when that commits. Two ways in, both ending in
// SidecarGateway.cancelByMessage(..., STATE_EXITED):
//
// - LISTEN, when given a direct connection (--listen-db-url): one dedicated
//   pg.Client, outside the pool, so sub-second. It never LISTENs through
//   --db-url: behind a transaction-mode pooler (SPEC-007) a LISTEN silently
//   receives nothing. NOTIFY is at most once, so the client reconnects with
//   backoff and sweeps right after each (re)connect to cover the gap.
// - The sweep: every sweepIntervalMs, while invokes are in flight, one query
//   for which of their messages are no longer queued. The backstop for a
//   missed notification, and the only way in without --listen-db-url.
//
// A notification for a message this gateway isn't running (another replica's)
// cancels nothing and is ignored.

import { getLogger } from "@logtape/logtape";
// @ts-types="@types/pg"
import pg from "pg";
import { asyncOperationMessagesNotQueued, type DBDeps } from "@pgfsm/db";
import {
  CANCEL_REASON,
  type InvokeMessage,
  type SidecarGateway,
} from "./sidecar/gateway.ts";

const logger = getLogger([
  "@pgfsm/worker",
  "async-op-worker-gateway",
  "cancel-detection",
]);

/** The channel finish_async_operation_event_v2 notifies a cancel on. */
export const CANCEL_CHANNEL = "fsm_async_operation_cancel";
export const DEFAULT_CANCEL_SWEEP_INTERVAL_MS = 5_000;
const RECONNECT_INITIAL_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

export interface CancelDetectionOptions {
  /**
   * A direct (or session-mode) connection URL to LISTEN on. Unset: the
   * sweep alone detects cancels. Never a transaction-mode pooler's URL.
   */
  listenDbUrl?: string;
  /** How often to sweep, in ms; 0 turns the sweep off. Default 5000. */
  sweepIntervalMs?: number;
  /** The listener's first reconnect delay; it doubles up to the max. */
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  signal?: AbortSignal;
}

export interface CancelDetection {
  /** Stops the sweep and closes the listener's connection. */
  stop(): Promise<void>;
}

/** The {queue_name, msg_id} payload of a cancel notification, or null. */
export function parseCancelNotification(
  payload: string | undefined,
): InvokeMessage | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as {
      queue_name?: unknown;
      msg_id?: unknown;
    };
    if (
      typeof parsed.queue_name !== "string" || parsed.queue_name === "" ||
      (typeof parsed.msg_id !== "number" && typeof parsed.msg_id !== "string")
    ) {
      return null;
    }
    return { queueName: parsed.queue_name, msgId: parsed.msg_id };
  } catch {
    return null;
  }
}

/**
 * One sweep: cancels every in-flight invoke whose message is no longer queued
 * (its state exited). Returns how many invokes were cancelled. No query when
 * nothing is in flight.
 */
export async function sweepOnce(
  sidecar: SidecarGateway,
  deps: DBDeps,
): Promise<number> {
  const pending = sidecar.listPendingMessages();
  if (pending.length === 0) return 0;
  const gone = await asyncOperationMessagesNotQueued(deps, pending);
  let cancelled = 0;
  for (const message of gone) {
    const count = sidecar.cancelByMessage(
      message,
      CANCEL_REASON.STATE_EXITED,
    );
    if (count > 0) {
      logger.info(
        "Cancelled {count} invoke(s) of message {msgId} on {queueName}: its state exited (sweep)",
        { count, msgId: String(message.msgId), queueName: message.queueName },
      );
    }
    cancelled += count;
  }
  return cancelled;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Starts detecting cancels of in-flight invokes: the LISTEN connection when
 * `listenDbUrl` is set, and the sweep unless `sweepIntervalMs` is 0. Runs
 * until `stop()` or `signal` aborts.
 */
export function startCancelDetection(
  sidecar: SidecarGateway,
  deps: DBDeps,
  options: CancelDetectionOptions = {},
): CancelDetection {
  const sweepIntervalMs = options.sweepIntervalMs ??
    DEFAULT_CANCEL_SWEEP_INTERVAL_MS;
  const initialDelay = options.reconnectInitialDelayMs ??
    RECONNECT_INITIAL_DELAY_MS;
  const maxDelay = options.reconnectMaxDelayMs ?? RECONNECT_MAX_DELAY_MS;
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const { signal } = controller;

  const sweep = async (source: string) => {
    try {
      await sweepOnce(sidecar, deps);
    } catch (error) {
      logger.warn("Cancel sweep ({source}) failed: {error}", {
        source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  if (options.listenDbUrl) {
    logger.info(
      "Detecting cancelled invokes by LISTEN on {channel} (--listen-db-url){sweep}",
      {
        channel: CANCEL_CHANNEL,
        sweep: sweepIntervalMs > 0
          ? `, with a sweep every ${sweepIntervalMs}ms`
          : ", without a sweep",
      },
    );
  } else if (sweepIntervalMs > 0) {
    logger.info(
      "Detecting cancelled invokes by sweep only, every {intervalMs}ms: set --listen-db-url to a direct (not transaction-pooled) connection for sub-second cancels",
      { intervalMs: sweepIntervalMs },
    );
  } else {
    logger.warn(
      "Cancelling in-flight invokes whose state exited is off: no --listen-db-url and --cancel-sweep-interval-ms 0",
    );
  }

  const sweepLoop = (async () => {
    if (sweepIntervalMs <= 0) return;
    while (!signal.aborted) {
      await abortableSleep(sweepIntervalMs, signal);
      if (signal.aborted) break;
      await sweep("interval");
    }
  })();

  let client: pg.Client | undefined;
  const listenLoop = (async () => {
    if (!options.listenDbUrl) return;
    let delay = initialDelay;
    while (!signal.aborted) {
      const current = new pg.Client({ connectionString: options.listenDbUrl });
      client = current;
      // Resolves when this connection is lost or detection stops.
      const lost = new Promise<void>((resolve) => {
        current.once("end", () => resolve());
        current.on("error", (error: Error) => {
          logger.warn("Cancel LISTEN connection error: {error}", {
            error: error.message,
          });
          resolve();
        });
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      current.on(
        "notification",
        (notification: { channel: string; payload?: string }) => {
          if (notification.channel !== CANCEL_CHANNEL) return;
          const message = parseCancelNotification(notification.payload);
          if (!message) {
            logger.warn("Ignoring a malformed cancel notification: {payload}", {
              payload: notification.payload,
            });
            return;
          }
          const count = sidecar.cancelByMessage(
            message,
            CANCEL_REASON.STATE_EXITED,
          );
          if (count > 0) {
            logger.info(
              "Cancelled {count} invoke(s) of message {msgId} on {queueName}: its state exited (LISTEN)",
              {
                count,
                msgId: String(message.msgId),
                queueName: message.queueName,
              },
            );
          } else {
            logger.debug(
              "Cancel of message {msgId} on {queueName}: not in flight here",
              { msgId: String(message.msgId), queueName: message.queueName },
            );
          }
        },
      );
      try {
        await current.connect();
        await current.query(`LISTEN ${CANCEL_CHANNEL}`);
        logger.info("Listening on {channel} for cancelled invokes", {
          channel: CANCEL_CHANNEL,
        });
        delay = initialDelay;
        // Notifications sent while it wasn't listening are lost: sweep now.
        await sweep("listener connected");
        await lost;
      } catch (error) {
        logger.warn("Cancel LISTEN connection failed: {error}", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await current.end().catch(() => {});
      }
      if (signal.aborted) break;
      logger.info("Reconnecting the cancel LISTEN connection in {delayMs}ms", {
        delayMs: delay,
      });
      await abortableSleep(delay, signal);
      delay = Math.min(delay * 2, maxDelay);
    }
  })();

  return {
    async stop() {
      controller.abort();
      options.signal?.removeEventListener("abort", onOuterAbort);
      await client?.end().catch(() => {});
      await Promise.allSettled([sweepLoop, listenLoop]);
    },
  };
}
