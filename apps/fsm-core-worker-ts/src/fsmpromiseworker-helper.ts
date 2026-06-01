import type { Database, Json } from "@pgfsm/db/database.types";

import type { DBDeps } from "@pgfsm/db";
import type { FsmQueueMessage } from "./types.ts";

export type FSMPromiseArchiveData = {
  promise_queue_name: string;
  promise_queue_type: string;
  promise_queue_version: string;
  msg_id: number | null;
  event_name: string;
  event_action_type: string;
  event_data: Json;
  event_delay: number;
  send_to_parent_queue_id: string;
  send_to_parent_queue_id_msg_id: string;
  execution_started_at: string;
  execution_duration: number;
  execution_finished_at: string;
  event_output: Json;
  event_status: string;
  error_message: string | null;
};

export async function processFSMPromiseQueueMessage(
  deps: DBDeps,
  promise_queue_name: string,
  msg: Database["pgmq"]["CompositeTypes"]["message_record"],
  promise_fn_name: string,
  promise_version?: string,
  promise_queue_type?: string,
  actorFn?: ((input: unknown) => Promise<unknown>) | undefined,
): Promise<FSMPromiseArchiveData> {
  const execution_started_at = new Date().toISOString();
  const msg_id = msg.msg_id;
  const msgData = msg.message as unknown as FsmQueueMessage;
  const send_to_parent_queue_id = msgData.sendToParentQueueId ?? "";
  const send_to_parent_queue_id_msg_id = msgData.queueMsgId?.toString() ?? "";
  const event_name_base = msgData.sendToParentQueueIdEventName ?? "";
  const event_action_type = msgData.eventData?.actionType ?? "";
  const event_data_payload: Json = msgData.eventData?.eventPayload ?? null;

  let send_event_name_to_parent_queue_id = event_name_base;
  let event_output: Json;
  let error_message: string | null = null;

  if (actorFn) {
    try {
      const result = await actorFn(msgData.eventData?.eventPayload);
      send_event_name_to_parent_queue_id = "xstate.done.actor." + event_name_base;
      event_output = result as Json;
    } catch (err) {
      send_event_name_to_parent_queue_id = "xstate.error.actor." + event_name_base;
      error_message = String(err);
      event_output = { error: error_message };
    }
  } else {
    event_output = await new Promise((resolve) => {
      setTimeout(() => {
        const isSuccess = Math.random() < 0.5;
        if (isSuccess) {
          send_event_name_to_parent_queue_id = "xstate.done.actor." + event_name_base;
          resolve({ result: "Promise fulfilled successfully" });
        } else {
          send_event_name_to_parent_queue_id = "xstate.error.actor." + event_name_base;
          error_message = "Promise failed";
          resolve({ error: error_message });
        }
      }, 300);
    });
  }

  const event_status = error_message ? "failed" : "succeeded";
  const execution_finished_at = new Date().toISOString();
  const execution_duration = new Date(execution_finished_at).getTime() - new Date(execution_started_at).getTime();

  return {
    promise_queue_name,
    promise_queue_type: promise_queue_type ?? "",
    promise_queue_version: promise_version ?? "",
    msg_id,
    event_name: send_event_name_to_parent_queue_id,
    event_action_type,
    event_data: event_data_payload,
    event_delay: 0,
    send_to_parent_queue_id,
    send_to_parent_queue_id_msg_id,
    execution_started_at,
    execution_duration,
    execution_finished_at,
    event_output,
    event_status,
    error_message,
  };
}
