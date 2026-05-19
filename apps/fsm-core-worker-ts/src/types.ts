import type { Json } from "@fsm/db/database.types";

export interface FsmQueueMessageEventData {
  event_type: string;
  event_payload: Json;
  action_type: string;
}

export interface FsmQueueMessage {
  event_data: FsmQueueMessageEventData;
  queue_id: string;
  queue_type: string | null;
  queue_version: string | null;
  send_to_parent_queue_id: string | null;
  send_to_parent_queue_type: string | null;
  send_to_parent_queue_id_event_name: string;
}
