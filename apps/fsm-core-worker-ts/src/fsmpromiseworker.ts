import type { Database } from "@fsm/db/database.types";

import type { DBDeps } from "@fsm/db";

import { readMessage, pgmqQueueExists, archive_event_from_fsm_promise_type_worker, getFSMDataAndResolveStateValue } from "@fsm/db";

import { processFSMPromiseQueueMessage } from "./fsmpromiseworker-helper.ts";
import type { VerifiedModule } from "./fsmworker.ts";


export async function startFSMPromiseWorker(
  deps: DBDeps,
  queueName: string,
  fsm_promise_name: string,
  fsm_promise_type: string,
  fsm_promise_version: string,
  verifiedModule?: VerifiedModule,
  signal?: AbortSignal,
): Promise<boolean> {
  const queueExists = await pgmqQueueExists(deps, queueName);
  if (!queueExists) {
    console.warn(`PGMQ queue for promise "${queueName}" does not exist.`);
    return false;
  }
  const visibilityTimeout = 30;
  
  // Load fsmModuleDefinition once using verifiedModule paths
  let fsmModuleDefinition: any = undefined;
  let actorFn: ((input: unknown) => Promise<unknown>) | undefined = undefined;
  if (verifiedModule?.fsmAbsFolderPath) {
    try {
      
      const base = `${verifiedModule.fsmAbsFolderPath}/typescript`;
      const [actors] = await Promise.allSettled([
        import(`${base}/actors/index.ts`),
      ]);
      fsmModuleDefinition = {
        actors: actors.status === "fulfilled" ? actors.value : null,
      };
      actorFn = fsmModuleDefinition?.actors 
      ? (fsmModuleDefinition?.actors[fsm_promise_name] as ((input: unknown) => Promise<unknown>) | undefined)
      : undefined;
     
      
    } catch (err) {
      console.warn(
        `⚠️ Could not load fsmModuleDefinition for ${fsm_promise_type} at ${fsm_promise_name}/${fsm_promise_version}:`,
        err,
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
          console.log("✅ Processing FSM message:", msg.message);

          // const fsmDataWithResolvedStateValue =
          //   await getFSMDataAndResolveStateValue(deps, queueName);
          // console.log(
          //   "Initial FSM state from DB:",
          //   fsmDataWithResolvedStateValue,
          // );

          
          // if(fsmDataWithResolvedStateValue) {
          
            const archiveData = await processFSMPromiseQueueMessage(
              deps,
              queueName,
              msg,
              fsm_promise_name,
              fsm_promise_version.toString(),
              fsm_promise_type,
              actorFn,
            );
            
            if (archiveData) {
              const archiveResult = await archive_event_from_fsm_promise_type_worker(
                deps,
                archiveData.promise_queue_name,
                archiveData.msg_id,
                archiveData.send_to_parent_queue_id,
                archiveData.send_event_name_to_parent_queue_id,
                archiveData.event_output,
                archiveData.event_status,
                archiveData.event_duration,
                archiveData.event_finished_at,
              );
              console.log("Message archived with result:", archiveResult);
            }
           
          // }else{
          //   console.warn("⚠️ No result from fsmDataWithResolvedStateValue, skipping processFSMPromiseQueueMessage and archiving.");
            
          // }
        } catch (err) {
          console.error("❌ Error processing FSM message:", err);
        }
      }
    }
  }


  return true;
}
