import { EventEmitter } from "node:events";

import type { DBDeps } from "@fsm/db";

import { readMessage } from "@fsm/db";

import {
  archive_event_from_fsm_type_worker,
  getFSMDataAndResolveStateValue,
} from "@fsm/db";

import { macrostep_v2 } from "./fsmworker-helper.ts";

export function startFSMWorker(
  deps: DBDeps,
  queueName: string,
  fsm_name: string,
  fsm_version: number,
): EventEmitter {
  const emitter = new EventEmitter();
  const visibilityTimeout = 30;

  console.log(
    `👷 Started FSM worker for queue: ${queueName} with fsm_name ${fsm_name} and fsm_version ${fsm_version}`,
  );

  (async () => {
    // Dynamically import actions implementation for this FSM/version (if present)
    let actionsModule: any = null;
    try {
      actionsModule = await import(
        `../fsmMachines/${fsm_name}/${fsm_version}/actions/index.ts`
      );
      console.log(`📦 Loaded actions for ${fsm_name}/${fsm_version}`);
    } catch (err) {
      console.warn(
        `⚠️ Could not load actions for ${fsm_name}/${fsm_version}:`,
        err?.message || err,
      );
    }

    // Dynamically import delay implementation for this FSM/version (if present)
    let delayModule: any = null;
    try {
      delayModule = await import(
        `../fsmMachines/${fsm_name}/${fsm_version}/delay/index.ts`
      );
      console.log(`📦 Loaded delay for ${fsm_name}/${fsm_version}`);
    } catch (err) {
      console.warn(
        `⚠️ Could not load delay for ${fsm_name}/${fsm_version}:`,
        err?.message || err,
      );
    }

    while (true) {
      const messages = await readMessage(deps, queueName, visibilityTimeout);
      if (messages.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      for (const msg of messages) {
        if (msg.message && msg.msg_id) {
          try {
            console.log("✅ Processing FSM message:", msg.message);

            const fsmDataWithResolvedStateValue =
              await getFSMDataAndResolveStateValue(deps, queueName);
            console.log(
              "Initial FSM state from DB:",
              fsmDataWithResolvedStateValue,
            );

            const macrostep_v2_result = await macrostep_v2(
              deps,
              queueName,
              msg,
              fsmDataWithResolvedStateValue.fsm_instance_row,
              fsmDataWithResolvedStateValue.resolved_state_value,
              fsm_name,
              fsm_version,
              actionsModule,
              delayModule,
            );
            console.log("Macrostep result:", macrostep_v2_result);
            if (macrostep_v2_result) {
              const archiveResult = await archive_event_from_fsm_type_worker(
                deps,
                macrostep_v2_result.remove_from_current_fsm_instance_queue_id,
                macrostep_v2_result.remove_current_queue_msg_id,
                macrostep_v2_result.remove_schedule_queue_msg_ids,
                macrostep_v2_result.remove_promise_queue_msg_ids,
                macrostep_v2_result.new_schedule_queue_data,
                macrostep_v2_result.new_promise_queue_data,
                macrostep_v2_result.total_schedule_queue_data,
                macrostep_v2_result.total_promise_queue_data,
                macrostep_v2_result.fsm_instance_data_save_fsm_status,
                macrostep_v2_result.fsm_instance_data_save_fsm_state,
                macrostep_v2_result.fsm_instance_data_save_fsm_context,
                macrostep_v2_result.fsm_instance_data_save_fsm_xstate_state,
              );
              console.log("Message archived with result:", archiveResult);
            }

            emitter.emit("message", msg);
          } catch (err) {
            console.error("❌ Error processing FSM message:", err);
            emitter.emit("error", err);
          }
        }
      }
    }
  })();

  return emitter;
}
