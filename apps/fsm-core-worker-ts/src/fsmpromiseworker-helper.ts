import type { Database, Json } from "@fsm/db/database.types";

import type { DBDeps } from "@fsm/db";

export type FSMPromiseArchiveData = {
  promise_queue_name: string;
  msg_id: number | null;
  send_to_parent_queue_id: string;
  send_event_name_to_parent_queue_id: string;
  event_output: Json;
  event_status: string;
  event_duration: number;
  event_finished_at: string;
};

export async function processFSMPromiseQueueMessage(
  deps: DBDeps,
  queueName: string,
  msg: Database["pgmq"]["CompositeTypes"]["message_record"],
  promise_queue_name: string,
  promise_version?: string,
): Promise<FSMPromiseArchiveData> {
  const msg_id = msg.msg_id;
  const eventData = msg.message as any;
  const send_to_parent_queue_id = eventData.send_to_parent_queue_id;
  let send_event_name_to_parent_queue_id =
    eventData.send_event_name_to_parent_queue_id;

  let event_output: Json;

  event_output = await new Promise((resolve) => {
    setTimeout(() => {
      const isSuccess = Math.random() < 0.5;
      if (isSuccess) {
        send_event_name_to_parent_queue_id = "xstate.done.actor." +
          send_event_name_to_parent_queue_id;
        resolve({ result: "Promise fulfilled successfully" });
      } else {
        send_event_name_to_parent_queue_id = "xstate.error.actor." +
          send_event_name_to_parent_queue_id;
        resolve({ error: "Promise failed" });
      }
    }, 300);
  });

  const event_status = event_output && (event_output as any).error
    ? "failed"
    : "succeeded";
  const event_duration = 300;
  const event_finished_at = new Date().toISOString();

  return {
    promise_queue_name,
    msg_id,
    send_to_parent_queue_id,
    send_event_name_to_parent_queue_id,
    event_output,
    event_status,
    event_duration,
    event_finished_at,
  };
}
