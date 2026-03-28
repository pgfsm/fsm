import type { Database } from "@fsm/db/database.types";

import type { DBDeps } from "@fsm/db";

import { readMessage, pgmqQueueExists, archive_event_from_fsm_promise_type_worker } from "@fsm/db";

import { processFSMPromiseQueueMessage } from "./fsmpromiseworker-helper.ts";

async function runFSMPromiseWorkerLoop(
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
          const archiveData = await processFSMPromiseQueueMessage(
            deps,
            queueName,
            msg,
            fsm_promise_name,
            fsm_promise_version.toString(),
          );
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
          console.log("archive_event_from_fsm_promise_type_worker result:", archiveResult);
        } catch (err) {
          console.error("❌ Error processing FSM promise message:", err);
        }
      }
    }
  }
}

export async function startFSMPromiseWorker(
  deps: DBDeps,
  queueName: string,
  fsm_promise_name: string,
  fsm_promise_version: number,
): Promise<boolean> {
  const queueExists = await pgmqQueueExists(deps, queueName);
  if (!queueExists) {
    console.warn(`PGMQ queue for promise "${queueName}" does not exist.`);
    return false;
  }

  runFSMPromiseWorkerLoop(deps, queueName, fsm_promise_name, fsm_promise_version).catch((err) => {
    console.error(`FSM Promise worker for queue "${queueName}" stopped:`, err);
  });

  return true;
}
