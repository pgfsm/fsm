import type { Database } from "@pgfsm/db/database.types";

import type { DBDeps } from "@pgfsm/db";

import { lockFsmInstance, readMessage, unlockFsmInstance } from "@pgfsm/db";

import {
  archiveEventFromFsmTypeWorker,
  getFsmDataResolveStateValue,
} from "@pgfsm/db";

import { validateFsmPluginLoadFromFolder } from "@pgfsm/compiler";
import type { WorkflowType } from "@pgfsm/compiler";

import { macrostepV2 } from "./fsmworker-helper.ts";
import type { FsmQueueMessage } from "./types.ts";

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
  fsmModuleDefinition?: any,
  signal?: AbortSignal,
) {
  const visibilityTimeout = 30;
  console.log(
    `👷 Started FSM worker for queue: ${queueName} with fsm_name ${fsm_name} and fsm_version ${fsm_version}`,
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
          console.log("✅ Processing FSM message:", msg.message);
          const msgData = msg.message as unknown as FsmQueueMessage;

          const fsmDataWithResolvedStateValue =
            await getFsmDataResolveStateValue(deps, queueName);
          console.log(
            "Initial FSM state from DB:",
            fsmDataWithResolvedStateValue,
          );

          // Here you would process the message
          //
          if(fsmDataWithResolvedStateValue) {
          
            const macrostepV2Result = await macrostepV2(
              deps,
              queueName,
              msg,
              fsmDataWithResolvedStateValue.fsm_instance_row,
              fsmDataWithResolvedStateValue.resolved_state_value,
              fsm_name,
              fsm_version,
              fsmModuleDefinition,
            );
            console.log("Macrostep result:", macrostepV2Result);
            if (macrostepV2Result) {
              const archiveResult = await archiveEventFromFsmTypeWorker(
                deps,
                macrostepV2Result.remove_from_current_fsm_instance_queue_id,
                macrostepV2Result.remove_current_queue_msg_id,
                macrostepV2Result.remove_schedule_queue_msg_ids,
                macrostepV2Result.remove_promise_queue_msg_ids,
                macrostepV2Result.new_schedule_queue_data,
                macrostepV2Result.new_promise_queue_data,
                macrostepV2Result.total_schedule_queue_data,
                macrostepV2Result.total_promise_queue_data,
                macrostepV2Result.fsm_instance_data_save_fsm_status,
                macrostepV2Result.fsm_instance_data_save_fsm_state,
                macrostepV2Result.fsm_instance_data_save_fsm_context,
                macrostepV2Result.fsm_instance_data_save_fsm_xstate_state,
                msgData.sendToParentQueueId ?? null,
                msgData.sendToParentQueueType ?? null,
                msgData.sendToParentQueueIdEventName ?? null,
              );
              console.log("Message archived with result:", archiveResult);
            }
            // await archiveMessage(deps, queueName, msg.msg_id || 1);
          }else{
            console.warn("⚠️ No result from macrostepV2, skipping archiving.");

          }
        } catch (err) {
          console.error("❌ Error processing FSM message:", err);
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
  verifiedModule?: VerifiedModule,
  validatePlugin?: boolean,
  signal?: AbortSignal,
  onStop?: () => void,
): Promise<{ status: "success" | "fail"; message: string }> {
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

  if (!fsmModuleDefinition) {
    return { status: "fail", message: `Failed to load module for ${fsm_name}/${fsm_version}` };
  }

  if (!(await lockFsmInstance(deps, queueName))) {
    return { status: "fail", message: `Failed to acquire lock for queue "${queueName}" — another worker may already hold it` };
  }

  const cleanup = () => {
    unlockFsmInstance(deps, queueName);
    onStop?.();
  };
  try {
    await startFSMWorker(deps, queueName, fsm_name, fsm_version, fsmModuleDefinition, signal);
    console.log(`FSM Lock for queue "${queueName}" released after graceful stop.`);
  } catch (err) {
    console.error(`FSM Worker for queue "${queueName}" stopped:`, err);
    console.log(`FSM Lock for queue "${queueName}" has been released.`);
  } finally {
    cleanup();
  }
  return { status: "success", message: `Worker for queue "${queueName}" started successfully.` };
}
