import { getLogger } from "@logtape/logtape";

import type { DBDeps } from "@pgfsm/db";

const logger = getLogger(["@pgfsm/worker", "worker"]);

import { lockFsmInstance, readMessage, unlockFsmInstance } from "@pgfsm/db";

import {
  archiveEventFromFsmTypeWorker,
  getFsmDataResolveStateValue,
} from "@pgfsm/db";

import { macrostepV2 } from "../fsmlet/fsmworker-helper.ts";
import { hasInternalEvents, takeNextEvent } from "./internal-events.ts";
import type { SyncOperationRegistration } from "./type.ts";

export async function startFSMWorker(
  deps: DBDeps,
  queueName: string,
  fsm_name: string,
  fsm_version: number | string,
  syncOperationRegistrations: SyncOperationRegistration[],
  signal?: AbortSignal,
) {
  const visibilityTimeout = 30;
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
      logger.info("Processing {source} event: {message}", {
        source: next.source,
        message: next.msg.message,
      });
      logger.info("Initial FSM state from DB: {state}", { state: instance });

      const macrostepV2Result = await macrostepV2(
        deps,
        queueName,
        next.msg,
        instance.fsm_instance_row,
        instance.resolved_state_value,
        fsm_name,
        fsm_version,
        syncOperationRegistrations,
      );
      logger.info("Macrostep result: {result}", {
        result: macrostepV2Result,
      });
      if (!macrostepV2Result) {
        logger.warning("No result from macrostepV2, skipping archiving");
        continue;
      }
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
      logger.info("{source} event archived with result: {result}", {
        source: next.source,
        result: archiveResult,
      });
      internalEventsPending = hasInternalEvents(archiveResult);

      // A finished instance needs no worker: returning releases its lock and
      // frees this fsmlet's slot for another instance
      // (startFSMWorkerWithDBLock's cleanup), instead of holding it forever
      // (#500). An instance in error stops too, as an XState actor does (#520).
      const status = macrostepV2Result.fsm_instance_data_save_fsm_status;
      if (status === "done" || status === "error") {
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
