// 30-second poll loop implementing GOAL.md's steps 3-7: every tick, ask
// Postgres (via claimPendingAsyncOperationEventsWithCapacity) for
// pending work matching this gateway's currently-registered actors, at most
// as many messages per actor as its workers have free slots (SPEC-007),
// dispatch each claimed event via the sidecar's gRPC/IPC invoke path, and
// archive the result. Retriable failures aren't archived; the message is
// delivered again after its visibility timeout (#396).
//
// This package is a standalone alternative to fsm-async-worker-ts, not
// something layered on top of it -- it owns this poll/dispatch/archive loop
// end to end, including its own Postgres connection (DBDeps), rather than
// being invoked by an external orchestrator's poll/claim/archive loop.

import { getLogger } from "@logtape/logtape";
import type { AsyncOperationWorkerClaim, DBDeps, Json } from "@pgfsm/db";
import {
  archiveEventFromFsmAsyncOperationTypeWorker,
  claimPendingAsyncOperationEventsWithCapacity,
} from "@pgfsm/db";
import { ActivityInvokeError, type SidecarGateway } from "./sidecar/gateway.ts";

const logger = getLogger([
  "@pgfsm/worker",
  "async-op-worker-gateway",
  "poll-loop",
]);

export interface AsyncOpPollLoopOptions {
  /** How often to poll, in ms. Default 30_000 (30 seconds), per GOAL.md. */
  intervalMs?: number;
  /**
   * Per-invoke timeout for actors that don't declare their own `timeout_ms`.
   * Default 10_000.
   */
  invokeTimeoutMs?: number;
  /**
   * Seconds added to an actor's invoke timeout to get the visibility timeout
   * its claimed messages get, so none becomes visible again while its invoke
   * may still be running (SPEC-007 §6). Default 10.
   */
  vtMarginSeconds?: number;
  /**
   * How many times a message is delivered before a retriable failure (no
   * worker, worker disconnected, timeout, draining worker) is finally archived
   * as an actor error instead of being left for redelivery (#396). Default 5.
   */
  maxDeliveryAttempts?: number;
  signal?: AbortSignal;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_INVOKE_TIMEOUT_MS = 10_000;
export const DEFAULT_VT_MARGIN_SECONDS = 10;
export const DEFAULT_MAX_DELIVERY_ATTEMPTS = 5;

/** The timeout an actor's invokes get: its own `timeout_ms`, else the default. */
export function effectiveTimeoutMs(
  actorTimeoutMs: number | undefined,
  defaultTimeoutMs: number,
): number {
  return actorTimeoutMs && actorTimeoutMs > 0
    ? actorTimeoutMs
    : defaultTimeoutMs;
}

/** Visibility timeout for an actor's claimed messages (SPEC-007 §6). */
export function visibilityTimeoutSeconds(
  timeoutMs: number,
  marginSeconds: number,
): number {
  return Math.ceil(timeoutMs / 1000) + marginSeconds;
}

/**
 * Shape of one claimed pending-work row, returned by
 * `claim_pending_async_operation_events_for_workers_v2` (see that function's own
 * doc comment for the PGMQ message payload it's derived from) -- carries
 * enough to both dispatch (identity + input + instance/correlation ids) and
 * archive (queue name/type/version + msg id + event routing fields) the
 * result.
 */
interface ClaimedAsyncOperationEvent {
  parentFsmName: string;
  parentFsmVersion: string;
  asyncOperationType: string;
  asyncOperationName: string;
  asyncOperationVersion: string;
  asyncOperationLanguage: string;
  input: unknown;
  instanceId: string;
  correlationId: string;
  asyncOperationQueueName: string;
  asyncOperationQueueType: string;
  asyncOperationQueueVersion: string;
  msgId: number;
  eventName: string;
  eventActionType: string;
  eventDelay: number;
  sendToParentQueueId: string;
  sendToParentQueueIdEventName: string;
  /** PGMQ read_ct: how many times this message has been claimed (≥ 1). */
  readCount: number;
}

const REQUIRED_CLAIMED_EVENT_KEYS: (keyof ClaimedAsyncOperationEvent)[] = [
  "parentFsmName",
  "parentFsmVersion",
  "asyncOperationType",
  "asyncOperationName",
  "asyncOperationVersion",
  "asyncOperationLanguage",
  "instanceId",
  "correlationId",
  "asyncOperationQueueName",
  "asyncOperationQueueType",
  "asyncOperationQueueVersion",
  "msgId",
  "eventName",
  "eventActionType",
  "sendToParentQueueId",
  "sendToParentQueueIdEventName",
];

export function parseClaimedAsyncOperationEvent(
  row: unknown,
): ClaimedAsyncOperationEvent | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  for (const key of REQUIRED_CLAIMED_EVENT_KEYS) {
    if (!(key in r)) return null;
  }
  return {
    ...(r as unknown as ClaimedAsyncOperationEvent),
    input: r.input ?? null,
    eventDelay: typeof r.eventDelay === "number" ? r.eventDelay : 0,
    readCount: typeof r.readCount === "number" ? r.readCount : 1,
  };
}

function actorKeyOf(
  event: Pick<
    ClaimedAsyncOperationEvent,
    | "parentFsmName"
    | "parentFsmVersion"
    | "asyncOperationType"
    | "asyncOperationName"
    | "asyncOperationVersion"
    | "asyncOperationLanguage"
  >,
): string {
  return [
    event.parentFsmName,
    event.parentFsmVersion,
    event.asyncOperationType,
    event.asyncOperationName,
    event.asyncOperationVersion,
    event.asyncOperationLanguage,
  ].join("@");
}

/**
 * Dispatches one claimed event via the sidecar's gRPC/IPC invoke path, then
 * archives the result (goal steps 5-6). Never throws — dispatch and archive
 * failures are both logged and swallowed, so one bad event can't take down
 * the poll loop or block any other event's dispatch.
 *
 * A retriable failure (no worker, the worker disconnected or is draining, a
 * timeout) says nothing about the actor, so it isn't archived: the message
 * stays on the queue and is delivered again once its visibility timeout ends
 * (#396). Only after `maxDeliveryAttempts` deliveries is it archived as an
 * actor error. Delivery is therefore at-least-once; actors must be idempotent.
 */
export async function dispatchAndArchive(
  sidecar: SidecarGateway,
  deps: DBDeps,
  event: ClaimedAsyncOperationEvent,
  invokeTimeoutMs: number,
  maxDeliveryAttempts: number = DEFAULT_MAX_DELIVERY_ATTEMPTS,
): Promise<void> {
  const executionStartedAt = new Date();
  let eventOutput: Json = null;
  let eventStatus = "succeeded";
  let errorMessage: string | null = null;

  try {
    const result = await sidecar.invoke(
      {
        parentFsmName: event.parentFsmName,
        parentFsmVersion: event.parentFsmVersion,
        asyncOperationType: event.asyncOperationType,
        asyncOperationName: event.asyncOperationName,
        asyncOperationVersion: event.asyncOperationVersion,
        asyncOperationLanguage: event.asyncOperationLanguage,
        input: event.input,
        instanceId: event.instanceId,
        correlationId: event.correlationId,
      },
      invokeTimeoutMs,
    );
    eventOutput = (result.output ?? null) as Json;
  } catch (error) {
    if (
      error instanceof ActivityInvokeError && error.retriable &&
      event.readCount < maxDeliveryAttempts
    ) {
      logger.warn(
        "Invoke of {actorKey} failed ({code}: {error}); leaving message {msgId} for redelivery (delivery {attempt} of {max})",
        {
          actorKey: actorKeyOf(event),
          code: error.code,
          error: error.message,
          msgId: event.msgId,
          attempt: event.readCount,
          max: maxDeliveryAttempts,
        },
      );
      return;
    }
    eventStatus = "failed";
    errorMessage = error instanceof ActivityInvokeError
      ? error.message
      : (error instanceof Error ? error.message : String(error));
    eventOutput = { error: errorMessage };
  }

  const executionFinishedAt = new Date();

  // Outcome-dependent prefix, matching fsm-async-worker-ts's working
  // convention exactly (fsmasyncoperationworker-helper.ts's
  // send_event_name_to_parent_queue_id): the fsmlet only recognizes
  // "xstate.done.actor.<base>" / "xstate.error.actor.<base>" as a valid
  // transition event -- the claimed row's raw eventName (the un-prefixed
  // state-node id the fsmlet itself sent, e.g.
  // "0.(machine).creditCheck.Verifying Credentials") never matches any
  // transition on its own, which used to leave the FSM stuck at that state
  // forever even though the actor invoke above succeeded.
  const prefixedEventName = `${
    eventStatus === "succeeded" ? "xstate.done.actor." : "xstate.error.actor."
  }${event.eventName}`;

  logger.info(
    "Dispatch result for actor {actorKey}, event {eventName}: status={status}, output={output}, error={error}",
    {
      actorKey: actorKeyOf(event),
      eventName: prefixedEventName,
      status: eventStatus,
      output: eventOutput,
      error: errorMessage,
    },
  );
  try {
    await archiveEventFromFsmAsyncOperationTypeWorker(
      deps,
      event.asyncOperationQueueName,
      event.asyncOperationQueueType,
      event.asyncOperationQueueVersion,
      event.msgId,
      prefixedEventName,
      event.eventActionType,
      eventOutput,
      event.eventDelay,
      event.sendToParentQueueId,
      event.sendToParentQueueIdEventName,
      executionStartedAt.toISOString(),
      executionFinishedAt.getTime() - executionStartedAt.getTime(),
      executionFinishedAt.toISOString(),
      eventStatus,
      eventOutput,
      errorMessage,
    );
  } catch (archiveError) {
    logger.error("Failed to archive event for actor {actorKey}: {error}", {
      actorKey: actorKeyOf(event),
      error: archiveError,
    });
  }
}

async function pollOnce(
  sidecar: SidecarGateway,
  deps: DBDeps,
  options: Required<
    Pick<
      AsyncOpPollLoopOptions,
      "invokeTimeoutMs" | "vtMarginSeconds" | "maxDeliveryAttempts"
    >
  >,
): Promise<void> {
  const actors = sidecar.listClaimableActors();
  if (actors.length === 0) {
    logger.info("No registered workers; skipping poll tick");
    return;
  }

  // Claim per actor only what this replica's workers can take right now, and
  // keep each message invisible for at least as long as its invoke may run.
  const timeoutByKey = new Map<string, number>();
  const claims: AsyncOperationWorkerClaim[] = [];
  for (const { identity, freeSlots } of actors) {
    const timeoutMs = effectiveTimeoutMs(
      identity.timeoutMs,
      options.invokeTimeoutMs,
    );
    timeoutByKey.set(actorKeyOf(identity), timeoutMs);
    if (freeSlots <= 0) continue;
    claims.push({
      parentFsmName: identity.parentFsmName,
      parentFsmVersion: identity.parentFsmVersion,
      asyncOperationType: identity.asyncOperationType,
      asyncOperationName: identity.asyncOperationName,
      asyncOperationVersion: identity.asyncOperationVersion,
      asyncOperationLanguage: identity.asyncOperationLanguage,
      qty: freeSlots,
      vtSeconds: visibilityTimeoutSeconds(timeoutMs, options.vtMarginSeconds),
    });
  }
  if (claims.length === 0) {
    logger.debug("Every registered actor is at capacity; skipping poll tick");
    return;
  }

  let claimed: Json[];
  try {
    claimed = await claimPendingAsyncOperationEventsWithCapacity(
      deps,
      claims,
    );
  } catch (error) {
    logger.error(
      "claimPendingAsyncOperationEventsWithCapacity failed: {error}",
      { error },
    );
    return;
  }
  logger.info("Claimed {count} pending events for {actorCount} actors", {
    count: claimed.length,
    actorCount: claims.length,
  });
  for (const row of claimed) {
    const event = parseClaimedAsyncOperationEvent(row);
    if (!event) {
      logger.error("Skipping unparseable claimed event row: {row}", {
        row,
      });
      continue;
    }
    // Fire-and-forget: one actor's dispatch never blocks another's, or the
    // next poll tick.
    dispatchAndArchive(
      sidecar,
      deps,
      event,
      timeoutByKey.get(actorKeyOf(event)) ?? options.invokeTimeoutMs,
      options.maxDeliveryAttempts,
    ).catch(
      (error) => {
        logger.error("dispatchAndArchive threw unexpectedly: {error}", {
          error,
        });
      },
    );
  }
}

/**
 * Starts the repeating poll loop (goal step 7). Each tick fetches the
 * sidecar's currently-registered worker identities, asks Postgres for
 * pending work matching them, and dispatches+archives every claimed event
 * without blocking the next tick. Runs until `options.signal` aborts.
 */
export function startAsyncOpPollLoop(
  sidecar: SidecarGateway,
  deps: DBDeps,
  options: AsyncOpPollLoopOptions = {},
): void {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const pollOptions = {
    invokeTimeoutMs: options.invokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS,
    vtMarginSeconds: options.vtMarginSeconds ?? DEFAULT_VT_MARGIN_SECONDS,
    maxDeliveryAttempts: options.maxDeliveryAttempts ??
      DEFAULT_MAX_DELIVERY_ATTEMPTS,
  };

  (async () => {
    while (!options.signal?.aborted) {
      await pollOnce(sidecar, deps, pollOptions);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  })();

  logger.info("Async-op poll loop started (interval={intervalMs}ms)", {
    intervalMs,
  });
}
