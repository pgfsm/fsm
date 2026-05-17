import type { Json } from "@fsm/db/database.types";

export interface FsmQueueMessageEventData {
  eventType: string;
  eventPayload: Json;
  actionType: string;
}

export interface FsmQueueMessage {
  eventData: FsmQueueMessageEventData;
  fsmInstanceId: string;
  fsmInstanceIdFsmType: string | null;
  fsmInstanceIdFsmVersion: string | null;
  sendToParentQueueId: string | null;
  sendToParentQueueType: string | null;
  sendToParentQueueIdMsgId: string | null;
  sendToParentQueueIdEventName: string;
}
