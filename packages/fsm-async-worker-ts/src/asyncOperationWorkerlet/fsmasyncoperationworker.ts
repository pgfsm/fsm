import { getLogger } from "@logtape/logtape";
import type { DBDeps } from "@pgfsm/db";

const logger = getLogger(["@pgfsm/worker", "internalAsyncOperation"]);

import {
  finishAsyncOperationEvent,
  pgmqQueueExists,
  readMessage,
} from "@pgfsm/db";

import { processFSMAsyncOperationQueueMessage } from "./fsmasyncoperationworker-helper.ts";
import type { ActorPluginValidationResult } from "@pgfsm/compiler";

export async function startFSMAsyncOperationWorker(
  deps: DBDeps,
  queueName: string,
  fsm_async_operation_name: string,
  fsm_async_operation_type: string,
  fsm_async_operation_version: string,
  actorResult?: ActorPluginValidationResult,
  signal?: AbortSignal,
): Promise<boolean> {
  const queueExists = await pgmqQueueExists(deps, queueName);
  if (!queueExists) {
    logger.warning(
      "PGMQ queue for async-operation {queueName} does not exist",
      {
        queueName,
      },
    );
    return false;
  }
  const visibilityTimeout = 30;

  let actorFn: ((input: unknown) => Promise<unknown>) | undefined = undefined;
  if (actorResult?.fsmModulePath) {
    try {
      const actorModule = await import(`file://${actorResult.fsmModulePath}`);
      actorFn = actorModule[actorResult.method ?? fsm_async_operation_name] as
        | ((input: unknown) => Promise<unknown>)
        | undefined;
    } catch (err) {
      logger.warning(
        "Could not load actor module for {type} at {path}: {error}",
        {
          type: fsm_async_operation_type,
          path: actorResult.fsmModulePath,
          error: err,
        },
      );
    }
  }

  while (!signal?.aborted) {
    const messages = await readMessage(deps, queueName, visibilityTimeout);
    if (messages.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    for (const msg of messages) {
      if (msg.message && msg.msg_id) {
        try {
          logger.info("Processing async-operation message: {message}", {
            message: msg.message,
          });

          // const fsmDataWithResolvedStateValue =
          //   await getFsmDataResolveStateValue(deps, queueName);
          // console.log(
          //   "Initial FSM state from DB:",
          //   fsmDataWithResolvedStateValue,
          // );

          // if(fsmDataWithResolvedStateValue) {

          const archiveData = await processFSMAsyncOperationQueueMessage(
            deps,
            queueName,
            msg,
            fsm_async_operation_name,
            fsm_async_operation_version.toString(),
            fsm_async_operation_type,
            actorFn,
          );

          if (archiveData) {
            const archiveResult = await finishAsyncOperationEvent(
              deps,
              "completed",
              archiveData.async_operation_queue_name,
              archiveData.msg_id!,
              {
                async_operation_queue_type:
                  archiveData.async_operation_queue_type,
                async_operation_queue_version:
                  archiveData.async_operation_queue_version,
                event_name: archiveData.event_name,
                event_action_type: archiveData.event_action_type,
                event_data: archiveData.event_data,
                event_delay: archiveData.event_delay,
                send_to_parent_queue_id: archiveData.send_to_parent_queue_id,
                send_to_parent_queue_id_event_name:
                  archiveData.send_to_parent_queue_id_msg_id,
                execution_started_at: archiveData.execution_started_at,
                execution_duration: archiveData.execution_duration,
                execution_finished_at: archiveData.execution_finished_at,
                event_status: archiveData.event_status,
                event_output: archiveData.event_output,
                error_message: archiveData.error_message,
              },
            );
            logger.info("Message archived with result: {result}", {
              result: archiveResult,
            });
          }

          // }else{
          //   console.warn("⚠️ No result from fsmDataWithResolvedStateValue, skipping processFSMAsyncOperationQueueMessage and archiving.");

          // }
        } catch (err) {
          logger.error("Error processing async-operation message: {error}", {
            error: err,
          });
        }
      }
    }
  }

  return true;
}
