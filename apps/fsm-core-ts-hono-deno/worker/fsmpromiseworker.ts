import type { Database } from "../../fsm-core-db-ts/src/database.types.ts";

import type { DBDeps } from "../../fsm-core-db-ts/src/custom-type.ts";

import {
  readMessage,
} from "../../fsm-core-db-ts/src/queue.ts";

import { processFSMPromiseQueueMessage } from "./fsmpromiseworker-helper.ts";

export async function startFSMPromiseWorker(
  deps: DBDeps,
  queueName: string,
  fsm_promise_name: string,
  fsm_promise_version: number,
) {
  const visibilityTimeout = 30;
  console.log(`👷 Started FSM Promise worker for queue: ${queueName}`);

  while (true) {
    const messages = await readMessage(deps, queueName, visibilityTimeout);
    if (messages.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    for (const msg of messages) {
      if (msg.message && msg.msg_id) {
        try {
          console.log("✅ Processing FSM promise message:", msg.message);
          // Here you would process the message
          await processFSMPromiseQueueMessage(
            deps,
            queueName,
            msg,
            fsm_promise_name,
            fsm_promise_version.toString(),
          );

          // await archiveMessage(deps, queueName, msg.msg_id || 1);
        } catch (err) {
          console.error("❌ Error processing FSM promise message:", err);
        }
      }
    }
  }
}
