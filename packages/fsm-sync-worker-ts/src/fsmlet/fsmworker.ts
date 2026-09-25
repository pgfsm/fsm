import { getLogger } from "@logtape/logtape";

import type { DBDeps } from "@pgfsm/db";

const logger = getLogger(["@pgfsm/worker", "worker"]);

import { lockFsmInstance, readMessage, unlockFsmInstance } from "@pgfsm/db";

import {
  archiveEventFromFsmTypeWorker,
  getFsmDataResolveStateValue,
} from "@pgfsm/db";

import { macrostepV2 } from "../fsmlet/fsmworker-helper.ts";
import type { FsmQueueMessage } from "../types.ts";
import type { SyncOperationRegistration } from "./type.ts";
import {
  loadAllSyncOperationRegistrations,
  syncOperationRegistrationsFor,
} from "./sync-operation-registrations.ts";

export async function startFSMWorker(
  deps: DBDeps,
  queueName: string,
  fsm_name: string,
  fsm_version: number | string,
  syncOperationRegistrations?: SyncOperationRegistration[],
  signal?: AbortSignal,
) {
  const visibilityTimeout = 30;
  logger.info(
    "Started FSM worker for queue: {queueName} with fsm_name {fsmName} and fsm_version {fsmVersion}",
    { queueName, fsmName: fsm_name, fsmVersion: fsm_version },
  );

  while (!signal?.aborted) {
    const messages = await readMessage(deps, queueName, visibilityTimeout);
    if (messages.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    for (const msg of messages) {
      if (msg.message && msg.msg_id) {
        try {
          logger.info("Processing FSM message: {message}", {
            message: msg.message,
          });
          const msgData = msg.message as unknown as FsmQueueMessage;

          const fsmDataWithResolvedStateValue =
            await getFsmDataResolveStateValue(deps, queueName);
          logger.info("Initial FSM state from DB: {state}", {
            state: fsmDataWithResolvedStateValue,
          });

          // Here you would process the message
          //
          if (fsmDataWithResolvedStateValue) {
            const macrostepV2Result = await macrostepV2(
              deps,
              queueName,
              msg,
              fsmDataWithResolvedStateValue.fsm_instance_row,
              fsmDataWithResolvedStateValue.resolved_state_value,
              fsm_name,
              fsm_version,
              syncOperationRegistrations,
            );
            logger.info("Macrostep result: {result}", {
              result: macrostepV2Result,
            });
            if (macrostepV2Result) {
              const archiveResult = await archiveEventFromFsmTypeWorker(
                deps,
                macrostepV2Result.remove_from_current_fsm_instance_queue_id,
                // Non-null: msg.msg_id was truthy-checked at the top of this loop.
                macrostepV2Result.remove_current_queue_msg_id!,
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
                msgData.sendToParentQueueId ?? null,
                msgData.sendToParentQueueType ?? null,
                msgData.sendToParentQueueIdEventName ?? null,
              );
              logger.info("Message archived with result: {result}", {
                result: archiveResult,
              });
            }
            // await archiveMessage(deps, queueName, msg.msg_id || 1);
          } else {
            logger.warning("No result from macrostepV2, skipping archiving");
          }
        } catch (err) {
          logger.error("Error processing FSM message: {error}", { error: err });
        }
      }
    }
  }
}

export async function startFSMWorkerWithDBLock(
  deps: DBDeps,
  queueName: string,
  fsm_name: string,
  fsm_version: number | string,
  signal?: AbortSignal,
  onStop?: () => void,
): Promise<{ status: "success" | "fail"; message: string }> {
  // Sync-operation handlers are resolved from the compiler-generated
  // aggregate registry (fsm-compiler-ts #338) rather than validated/loaded
  // per instance — the compiler is what guarantees these handlers exist, not
  // this process (see sync-operation-registrations.ts, #340).
  const allRegistrations = await loadAllSyncOperationRegistrations();
  if (!allRegistrations) {
    return {
      status: "fail",
      message:
        `Failed to load sync-operation registrations for ${fsm_name}/${fsm_version}`,
    };
  }
  const syncOperationRegistrations = syncOperationRegistrationsFor(
    allRegistrations,
    fsm_name,
    String(fsm_version),
  );
  logger.info(
    "Loaded {count} sync-operation registration(s) for {fsmName}/{fsmVersion}",
    {
      count: syncOperationRegistrations.length,
      fsmName: fsm_name,
      fsmVersion: fsm_version,
    },
  );

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
