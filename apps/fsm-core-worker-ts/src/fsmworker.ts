import type { Database } from "@fsm/db/database.types";

import type { DBDeps } from "@fsm/db";

import { readMessage } from "@fsm/db";

import {
  archive_event_from_fsm_type_worker,
  getFSMDataAndResolveStateValue,
} from "@fsm/db";

import { validateFsmPluginLoadFromFolder } from "@fsm/compiler";
import type { WorkflowType } from "@fsm/compiler";

import { macrostep_v2 } from "./fsmworker-helper.ts";

export type VerifiedModule = {
  fsmAbsFolderPath?: string | null;
  fsmRelativeFolderPath?: string;
  fsmParentDirName?: string;
  fsmParentAbsFolderPath?: string;
  fsmParentRelativeFolderPath?: string;
  fsmType?: string;
};

export async function startFSMWorker(
  deps: DBDeps,
  queueName: string,
  fsm_name: string,
  fsm_version: number | string,
  verifiedModule?: VerifiedModule,
  validatePlugin?: boolean,
) {
  const visibilityTimeout = 30;
  console.log(
    `👷 Started FSM worker for queue: ${queueName} with fsm_name ${fsm_name} and fsm_version ${fsm_version}`,
  );

  // Load fsmModuleDefinition once using verifiedModule paths
  let fsmModuleDefinition: any = undefined;
  if (verifiedModule?.fsmAbsFolderPath) {
    try {
      if (validatePlugin) {
        const fsmJsonPath = `${verifiedModule.fsmAbsFolderPath}/fsm.json`;
        const fsmJsonText = await Deno.readTextFile(fsmJsonPath);
        const fsmData = JSON.parse(fsmJsonText);
        const result = await validateFsmPluginLoadFromFolder(
          fsmData,
          fsm_name,
          String(fsm_version),
          verifiedModule.fsmAbsFolderPath,
          verifiedModule.fsmRelativeFolderPath ?? "",
          verifiedModule.fsmParentDirName ?? "",
          verifiedModule.fsmParentAbsFolderPath ?? "",
          verifiedModule.fsmParentRelativeFolderPath ?? "",
          (verifiedModule.fsmType ?? "fsm") as WorkflowType,
          [],
        );
        fsmModuleDefinition = result.fsmModuleDefinition;
        console.log(`📦 Loaded fsmModuleDefinition via validateFsmPluginLoadFromFolder for ${fsm_name}/${fsm_version}`);
      } else {
        const base = `${verifiedModule.fsmAbsFolderPath}/typescript`;
        const [actions, guards, delays, actors] = await Promise.allSettled([
          import(`${base}/actions/index.ts`),
          import(`${base}/guards/index.ts`),
          import(`${base}/delays/index.ts`),
          import(`${base}/actors/index.ts`),
        ]);
        fsmModuleDefinition = {
          actions: actions.status === "fulfilled" ? actions.value : null,
          guards: guards.status === "fulfilled" ? guards.value : null,
          delays: delays.status === "fulfilled" ? delays.value : null,
          actors: actors.status === "fulfilled" ? actors.value : null,
        };
        console.log(`📦 Loaded fsmModuleDefinition for ${fsm_name}/${fsm_version}`);
      }
    } catch (err) {
      console.warn(
        `⚠️ Could not load fsmModuleDefinition for ${fsm_name}/${fsm_version}:`,
        err,
      );
    }
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

          // Here you would process the message
          //
          if(fsmDataWithResolvedStateValue) {
          
            const macrostep_v2_result = await macrostep_v2(
              deps,
              queueName,
              msg,
              fsmDataWithResolvedStateValue.fsm_instance_row,
              fsmDataWithResolvedStateValue.resolved_state_value,
              fsm_name,
              fsm_version,
              fsmModuleDefinition,
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
            // await archiveMessage(deps, queueName, msg.msg_id || 1);
          }else{
            console.warn("⚠️ No result from macrostep_v2, skipping archiving.");
            
          }
        } catch (err) {
          console.error("❌ Error processing FSM message:", err);
        }
      }
    }
  }
}
