import { getLogger } from "@logtape/logtape";

import type { DBDeps } from "@pgfsm/db";

const logger = getLogger(["@pgfsm/worker", "worker"]);

import { lockFsmInstance, readMessage, unlockFsmInstance } from "@pgfsm/db";

import {
  archiveEventFromFsmTypeWorker,
  getFsmDataResolveStateValue,
} from "@pgfsm/db";

import { macrostepV2 } from "../fsmlet/fsmworker-helper.ts";
import {
  archiveOutcome,
  hasInternalEvents,
  isActiveStatus,
  takeNextEvent,
} from "./internal-events.ts";
import type { SyncOperationRegistration } from "./type.ts";
import {
  maxAttemptsFor,
  type SyncOperationRetryOptions,
} from "./sync-operation-error.ts";
import { runStepWithRetry } from "./step-retry.ts";

export async function startFSMWorker(
  deps: DBDeps,
  queueName: string,
  fsm_name: string,
  fsm_version: number | string,
  syncOperationRegistrations: SyncOperationRegistration[],
  signal?: AbortSignal,
  syncOperationRetry?: SyncOperationRetryOptions,
) {
  const visibilityTimeout = 30;
  const maxAttempts = maxAttemptsFor(syncOperationRetry, fsm_name);
  logger.info(
    "Started FSM worker for queue: {queueName} with fsm_name {fsmName} and fsm_version {fsmVersion}",
    { queueName, fsmName: fsm_name, fsmVersion: fsm_version },
  );

  // Internal events (the done.state events microstep_v2 raised) come before
  // the instance's pgmq queue (SPEC-010, #520). The row is read when the
  // worker starts, since a crash may have left internal events there; after
  // that each archive result says whether any are waiting.
  let internalEventsPending = true;

  while (!signal?.aborted) {
    const taken = await takeNextEvent(
      internalEventsPending,
      () => getFsmDataResolveStateValue(deps, queueName),
      async () => (await readMessage(deps, queueName, visibilityTimeout))[0],
    ).catch((err) => {
      logger.error("Error taking the next event: {error}", { error: err });
      return null;
    });
    if (!taken) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    const { next, instance } = taken;

    try {
      // A stopped or finished instance takes no more events. A stop archives
      // its queue and sends xstate.stop to wake this worker (SPEC-011, #534);
      // the archive's status gate archives the message, and the instance is
      // let go.
      const rowStatus = instance.fsm_instance_row.fsm_instance_status;
      if (!isActiveStatus(rowStatus)) {
        const row = instance.fsm_instance_row;
        const discarded = await archiveEventFromFsmTypeWorker(
          deps,
          queueName,
          next.source === "queue" ? next.msg.msg_id : null,
          null,
          null,
          null,
          null,
          null,
          null,
          rowStatus,
          row.fsm_instance_state,
          row.fsm_instance_context,
          row.fsm_instance_xstate_state,
          [],
          next.source === "internal" ? next.event : null,
          null,
        );
        logger.info(
          "FSM instance {queueName} is {status}; discarded its {source} event and stopping its worker: {result}",
          {
            queueName,
            status: rowStatus,
            source: next.source,
            result: discarded,
          },
        );
        return;
      }

      logger.info("Processing {source} event: {message}", {
        source: next.source,
        message: next.msg.message,
      });
      logger.info("Initial FSM state from DB: {state}", { state: instance });

      // SPEC-014: a step whose guard, action, delay or input mapper throws is
      // retried in place, taking nothing else for this instance, then saved
      // as status error; platform errors are retried and never count. No
      // visibility timeout to extend: only this worker, which holds the
      // instance's lock, reads its queue.
      const eventType = String(
        (next.msg.message as { eventData?: { eventType?: unknown } } | null)
          ?.eventData?.eventType ?? "",
      );
      // Each retry reads the instance again, as the loop's next event would:
      // nothing was saved, so it's still as it was before the step unless
      // something else changed it (a stop), and a platform error that a stale
      // read caused clears.
      let current = instance;
      let firstAttempt = true;
      const step = await runStepWithRetry({
        firstAttempt: next.source === "queue" ? next.msg.read_ct ?? 1 : 1,
        maxAttempts,
        eventType,
        signal,
        attemptStep: async () => {
          if (!firstAttempt) {
            current = (await getFsmDataResolveStateValue(deps, queueName)) ??
              current;
          }
          firstAttempt = false;
          // A copy per attempt: an action can change the context it's given in
          // place, and neither a retry nor the error save may see that.
          const macrostepV2Result = await macrostepV2(
            deps,
            queueName,
            structuredClone(next.msg),
            structuredClone(current.fsm_instance_row),
            structuredClone(current.resolved_state_value),
            fsm_name,
            fsm_version,
            syncOperationRegistrations,
          );
          logger.info("Macrostep result: {result}", {
            result: macrostepV2Result,
          });
          if (!macrostepV2Result) return null;
          const archiveResult = await archiveEventFromFsmTypeWorker(
            deps,
            macrostepV2Result.remove_from_current_fsm_instance_queue_id,
            // null for an internal event: it isn't a pgmq message.
            next.source === "queue" ? next.msg.msg_id : null,
            macrostepV2Result.to_be_removed_schedule_queue_msg_ids,
            macrostepV2Result.to_be_removed_async_operation_queue_msg_ids,
            macrostepV2Result.to_be_added_schedule_queue_data,
            macrostepV2Result.to_be_added_async_operation_queue_data,
            macrostepV2Result.input_total_schedule_queue_data,
            macrostepV2Result.input_total_async_operation_queue_data,
            macrostepV2Result.fsm_instance_data_save_fsm_status,
            macrostepV2Result.fsm_instance_data_save_fsm_state,
            macrostepV2Result.fsm_instance_data_save_fsm_context,
            macrostepV2Result.fsm_instance_data_save_fsm_xstate_state,
            macrostepV2Result.raised_events,
            next.source === "internal" ? next.event : null,
            macrostepV2Result.fsm_instance_data_save_fsm_error,
          );
          return {
            archiveResult,
            status: macrostepV2Result.fsm_instance_data_save_fsm_status,
          };
        },
        // Nothing from the failed step: the state and context it started
        // from, no new invokes or timers, and the event consumed. The
        // archive's terminal path stops the rest and tells a parent FSM
        // (SPEC-011).
        saveError: async (error) => {
          const row = current.fsm_instance_row;
          return {
            archiveResult: await archiveEventFromFsmTypeWorker(
              deps,
              queueName,
              next.source === "queue" ? next.msg.msg_id : null,
              null,
              null,
              null,
              null,
              null,
              null,
              "error",
              row.fsm_instance_state,
              row.fsm_instance_context,
              row.fsm_instance_xstate_state,
              [],
              next.source === "internal" ? next.event : null,
              error,
            ),
            status: "error" as const,
          };
        },
        onSyncOperationError: (error, attempt, delayMs) =>
          logger.warning(
            "Attempt {attempt} of {maxAttempts} for {eventType} failed: {error}; retrying in {delayMs} ms",
            { attempt, maxAttempts, eventType, error, delayMs },
          ),
        onPlatformError: (error, delayMs) =>
          logger.error(
            "Saving {eventType} failed: {error}; retrying in {delayMs} ms",
            { eventType, error, delayMs },
          ),
      });
      if (step.outcome === "aborted") return;
      if (step.outcome === "error_saved") {
        logger.error(
          "{eventType} failed {maxAttempts} attempts; FSM instance {queueName} is in error",
          { eventType, maxAttempts, queueName },
        );
      }
      if (!step.result) {
        logger.warning("No result from macrostepV2, skipping archiving");
        continue;
      }
      const { archiveResult } = step.result;
      logger.info("{source} event archived with result: {result}", {
        source: next.source,
        result: archiveResult,
      });
      internalEventsPending = hasInternalEvents(archiveResult);

      // The archive discards this macrostep, instead of saving it, when the
      // instance is no longer active, when its pgmq message was already
      // archived (another worker saved it first, or a stop archived the
      // queue), or when its internal event is no longer the queue's head
      // (SPEC-011, #534). Nothing was changed; it is not an error. The loop
      // goes on with the next event, or stops below if the instance isn't
      // active.
      const outcome = archiveOutcome(archiveResult, step.result.status);
      if (outcome.discarded) {
        logger.info("{source} event's macrostep was discarded: {reason}", {
          source: next.source,
          reason: outcome.reason,
        });
      }

      // A finished instance needs no worker: returning releases its lock and
      // frees this fsmlet's slot for another instance
      // (startFSMWorkerWithDBLock's cleanup), instead of holding it forever
      // (#500). An instance in error stops too, as an XState actor does
      // (#520), and so does a stopped one (#534). The status is the
      // archive's: the cycle cap can set error.
      const status = outcome.status;
      if (!isActiveStatus(status)) {
        logger.info(
          "FSM instance {queueName} is {status}; stopping its worker",
          {
            queueName,
            status,
          },
        );
        return;
      }
    } catch (err) {
      logger.error("Error processing {source} event: {error}", {
        source: next.source,
        error: err,
      });
      // Look at the internal queue again, and don't retry a failing internal
      // event in a tight loop (a pgmq message waits out its visibility
      // timeout instead).
      internalEventsPending = true;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

export async function startFSMWorkerWithDBLock(
  deps: DBDeps,
  queueName: string,
  fsm_name: string,
  fsm_version: number | string,
  syncOperationRegistrations: SyncOperationRegistration[],
  signal?: AbortSignal,
  onStop?: () => void,
  syncOperationRetry?: SyncOperationRetryOptions,
): Promise<{ status: "success" | "fail"; message: string }> {
  if (!(await lockFsmInstance(deps, queueName))) {
    return {
      status: "fail",
      message:
        `Failed to acquire lock for queue "${queueName}" — another worker may already hold it`,
    };
  }

  const cleanup = () => {
    unlockFsmInstance(deps, queueName);
    onStop?.();
  };
  try {
    await startFSMWorker(
      deps,
      queueName,
      fsm_name,
      fsm_version,
      syncOperationRegistrations,
      signal,
      syncOperationRetry,
    );
    logger.info("FSM Lock for queue {queueName} released after graceful stop", {
      queueName,
    });
  } catch (err) {
    logger.error("FSM Worker for queue {queueName} stopped: {error}", {
      queueName,
      error: err,
    });
    logger.info("FSM Lock for queue {queueName} has been released", {
      queueName,
    });
  } finally {
    cleanup();
  }
  return {
    status: "success",
    message: `Worker for queue "${queueName}" started successfully.`,
  };
}
