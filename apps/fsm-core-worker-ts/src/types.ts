import type { Database } from "@pgfsm/db/database.types";

export type FsmQueueMessageEventData = Database["fsm_core"]["CompositeTypes"]["fsm_event_data_v2"];

export type FsmQueueMessage = Database["fsm_core"]["CompositeTypes"]["fsm_queue_msg_data_v2"];
