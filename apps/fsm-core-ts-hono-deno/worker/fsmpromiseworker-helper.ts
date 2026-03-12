import type { Database } from "../../../apps/fsm-core-db/src/database.types.ts";

import type { DBDeps } from "../../../apps/fsm-core-db/src/custom-type.ts";
import {
  archive_event_from_fsm_promise_type_worker,
} from "../../../apps/fsm-core-db/src/fsm-instance.ts";

// Helper function to process a message for a given queue
// This function should be pure and reusable for different message processing logic
// @param deps - DBDeps for database access
// @param queueName - The name of the queue
// @param msg - The message object to process
// @returns Promise<void>
export async function processFSMPromiseQueueMessage(
  deps: DBDeps,
  queueName: string,
  msg: Database["pgmq"]["CompositeTypes"]["message_record"],
  promise_queue_name: string,
  promise_version?: string,
): Promise<void> {
  const msg_id = msg.msg_id;
  const eventData = msg.message as any;
  const eventType = eventData.type;
  const eventPayload = { ...eventData };
  const send_to_parent_queue_id = eventData.send_to_parent_queue_id;
  let send_event_name_to_parent_queue_id =
    eventData.send_event_name_to_parent_queue_id;

  let event_output;

  // implment promise and return random success or failure
  event_output = await new Promise((resolve) => {
    setTimeout(() => {
      const isSuccess = Math.random() < 0.5; // 50% chance of success
      if (isSuccess) {
        send_event_name_to_parent_queue_id = "xstate.done.actor." +
          send_event_name_to_parent_queue_id;
        resolve({ result: "Promise fulfilled successfully" });
      } else {
        send_event_name_to_parent_queue_id = "xstate.error.actor." +
          send_event_name_to_parent_queue_id;
        resolve({ error: "Promise failed" });
      }
    }, 300); // Simulate async operation delay
  });

  const event_status = event_output && (event_output as any).error
    ? "failed"
    : "succeeded";
  const event_duration = 300; // Simulated duration
  const event_finished_at = new Date().toISOString();

  try {
    const archiveResult = await archive_event_from_fsm_promise_type_worker(
      deps,
      promise_queue_name,
      msg_id,
      send_to_parent_queue_id,
      send_event_name_to_parent_queue_id,
      event_output,
      event_status,
      event_duration,
      event_finished_at,
    );
    // throw new Error('Not implemented yet');
    console.log(
      "archive_event_from_fsm_promise_type_worker result:",
      archiveResult,
    );
  } catch (err) {
    console.error(
      "Error calling archive_event_from_fsm_promise_type_worker:",
      err,
    );
  }
}
