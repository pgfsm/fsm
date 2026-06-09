import type { Database as DatabaseGenerated, Json } from "./database.types.ts";
import type { DBDeps } from "./custom-type.ts";

import { FSM_SCHEMA, FSM_SCHEMA_FN_VERSION } from "./const.ts";
import { toJsonbParam } from "./pg-utils.ts";

const FSM_INSTANCE_TABLE = `${FSM_SCHEMA}.fsm_instance`;
const CREATE_FSM_INSTANCE_FN = `${FSM_SCHEMA}.create_fsm_instance_from_name_${FSM_SCHEMA_FN_VERSION}`;
const ARCHIVE_EVENT_FROM_FSM_TYPE_WORKER_FN = `${FSM_SCHEMA}.archive_event_from_fsm_type_worker_${FSM_SCHEMA_FN_VERSION}`;
const ARCHIVE_EVENT_FROM_FSM_PROMISE_TYPE_WORKER_FN = `${FSM_SCHEMA}.archive_event_from_fsm_promise_type_worker_${FSM_SCHEMA_FN_VERSION}`;
const GET_FSM_DATA_RESOLVE_STATE_VALUE_FN = `${FSM_SCHEMA}.get_fsm_data_resolve_state_value_${FSM_SCHEMA_FN_VERSION}`;
const SEND_EVENT_TO_QUEUE_WITH_EVENT_LOGS_FN = `${FSM_SCHEMA}.send_event_to_fsm_queue_with_event_logs_${FSM_SCHEMA_FN_VERSION}`;

type FsmInstanceRow = DatabaseGenerated["fsm_core"]["Tables"]["fsm_instance"]["Row"];
type ArchiveWorkerArgs = DatabaseGenerated["fsm_core"]["Functions"]["archive_event_from_fsm_type_worker_v2"]["Args"];
type ArchivePromiseWorkerArgs = DatabaseGenerated["fsm_core"]["Functions"]["archive_event_from_fsm_promise_type_worker_v2"]["Args"];
type SendEventArgs = DatabaseGenerated["fsm_core"]["Functions"]["send_event_to_fsm_queue_with_event_logs_v2"]["Args"];
type CreateInstanceArgs = DatabaseGenerated["fsm_core"]["Functions"]["create_fsm_instance_from_name_v2"]["Args"];


export async function listFsmInstances(
  deps: DBDeps,
): Promise<FsmInstanceRow[]> {
  try {
    const text = `
      SELECT *
      FROM ${FSM_INSTANCE_TABLE}
      ORDER BY created_at DESC;
    `;
    const result = await deps.db.query<FsmInstanceRow>(text);
    return Array.isArray(result.rows) ? result.rows : [];
  } catch (err) {
    console.error("Error in listFsmInstances:", err);
    throw new Error("Failed to list FSM instances", { cause: err });
  }
}


export async function isFSMInstancePresent(
  deps: DBDeps,
  queue: FsmInstanceRow["id"],
): Promise<boolean> {
  try {
    const text = `
      SELECT id
      FROM ${FSM_INSTANCE_TABLE}
      WHERE id = $1::text;
    `;
    const result = await deps.db.query<{ id: string }>(text, [queue]);
    return Array.isArray(result.rows) ? result.rows.length > 0 : !!result.rows;
  } catch (err) {
    console.error("Error in isFSMInstancePresent:", err);
    throw new Error("Failed to check FSM instance presence", { cause: err });
  }
}


export async function createFsmInstanceFromName(
  deps: DBDeps,
  input_fsm_name: CreateInstanceArgs["input_fsm_name"],
  input_fsm_version: CreateInstanceArgs["input_fsm_version"],
  input_fsm_context: CreateInstanceArgs["input_fsm_context"],
  create_pgmq_queue: NonNullable<CreateInstanceArgs["create_pgmq_queue"]> = false,
): Promise<Json> {
  try {
    const text = `
      SELECT ${CREATE_FSM_INSTANCE_FN}(
        $1::text,
        $2::text,
        $3::jsonb,
        $4::boolean
      ) AS instance_result;
    `;
    const values = [input_fsm_name, input_fsm_version, toJsonbParam(input_fsm_context), create_pgmq_queue];
    const result = await deps.db.query<{ instance_result: Json }>(
      text,
      values,
    );
    return result.rows && result.rows[0] ? result.rows[0].instance_result : null;
  } catch (err) {
    console.error("Error in createFsmInstanceFromName:", err);
    throw new Error("Failed to create FSM instance from name", { cause: err });
  }
}


export async function archiveEventFromFsmTypeWorker(
  deps: DBDeps,
  remove_from_current_fsm_instance_queue_id: ArchiveWorkerArgs["remove_from_current_fsm_instance_queue_id"],
  remove_current_queue_msg_id: ArchiveWorkerArgs["remove_current_queue_msg_id"],
  to_be_removed_schedule_queue_msg_ids: ArchiveWorkerArgs["to_be_removed_schedule_queue_msg_ids"] | null,
  to_be_removed_promise_queue_msg_ids: ArchiveWorkerArgs["to_be_removed_promise_queue_msg_ids"] | null,
  to_be_added_schedule_queue_data: ArchiveWorkerArgs["to_be_added_schedule_queue_data"] | null,
  to_be_added_promise_queue_data: ArchiveWorkerArgs["to_be_added_promise_queue_data"] | null,
  total_schedule_queue_data: ArchiveWorkerArgs["input_total_schedule_queue_data"] | null,
  total_promise_queue_data: ArchiveWorkerArgs["input_total_promise_queue_data"] | null,
  fsm_instance_data_save_fsm_status: ArchiveWorkerArgs["fsm_instance_data_save_fsm_status"],
  fsm_instance_data_save_fsm_state: ArchiveWorkerArgs["fsm_instance_data_save_fsm_state"],
  fsm_instance_data_save_fsm_context: ArchiveWorkerArgs["fsm_instance_data_save_fsm_context"],
  fsm_instance_data_save_fsm_xstate_state: ArchiveWorkerArgs["fsm_instance_data_save_fsm_xstate_state"],
  send_to_parent_queue_id: string | null,
  send_to_parent_queue_type: string | null,
  send_to_parent_queue_id_event_name: string | null,
): Promise<Json> {
  try {
    const text = `
      SELECT * FROM ${ARCHIVE_EVENT_FROM_FSM_TYPE_WORKER_FN}(
        $1::text,
        $2::bigint,
        $3::jsonb,
        $4::jsonb,
        $5::jsonb,
        $6::jsonb,
        $7::jsonb,
        $8::jsonb,
        $9::jsonb,
        $10::jsonb,
        $11::jsonb,
        $12::jsonb,
        $13::uuid,
        $14::text,
        $15::text
      ) AS result;
    `;
    const values = [
      remove_from_current_fsm_instance_queue_id,
      remove_current_queue_msg_id,
      toJsonbParam(to_be_removed_schedule_queue_msg_ids),
      toJsonbParam(to_be_removed_promise_queue_msg_ids),
      toJsonbParam(to_be_added_schedule_queue_data),
      toJsonbParam(to_be_added_promise_queue_data),
      toJsonbParam(total_schedule_queue_data),
      toJsonbParam(total_promise_queue_data),
      toJsonbParam(fsm_instance_data_save_fsm_status),
      toJsonbParam(fsm_instance_data_save_fsm_state),
      toJsonbParam(fsm_instance_data_save_fsm_context),
      toJsonbParam(fsm_instance_data_save_fsm_xstate_state),
      send_to_parent_queue_id,
      send_to_parent_queue_type,
      send_to_parent_queue_id_event_name,
    ];
    const res = await deps.db.query<{ result: Json }>(text, values);
    return res.rows?.[0]?.result ?? null;
  } catch (err) {
    console.error("Error in archiveEventFromFsmTypeWorker:", err);
    throw new Error("Failed to archive event from FSM type worker", { cause: err });
  }
}

export async function archiveEventFromFsmPromiseTypeWorker(
  deps: DBDeps,
  promise_queue_name: ArchivePromiseWorkerArgs["input_promise_queue_name"],
  promise_queue_type: ArchivePromiseWorkerArgs["input_promise_queue_type"],
  promise_queue_version: ArchivePromiseWorkerArgs["input_promise_queue_version"],
  promise_queue_msg_id: ArchivePromiseWorkerArgs["input_promise_queue_msg_id"],
  event_name: ArchivePromiseWorkerArgs["input_event_name"],
  event_action_type: ArchivePromiseWorkerArgs["input_event_action_type"],
  event_data: ArchivePromiseWorkerArgs["input_event_data"],
  event_delay: ArchivePromiseWorkerArgs["input_event_delay"],
  send_to_parent_queue_id: ArchivePromiseWorkerArgs["input_send_to_parent_queue_id"],
  send_to_parent_queue_id_event_name: ArchivePromiseWorkerArgs["input_send_to_parent_queue_id_event_name"],
  execution_started_at: ArchivePromiseWorkerArgs["input_execution_started_at"],
  execution_duration: ArchivePromiseWorkerArgs["input_execution_duration"],
  execution_finished_at: ArchivePromiseWorkerArgs["input_execution_finished_at"],
  event_status: ArchivePromiseWorkerArgs["input_event_status"],
  event_output: ArchivePromiseWorkerArgs["input_event_output"],
  error_message: ArchivePromiseWorkerArgs["input_error_message"] | null,
): Promise<Json> {
  try {
    const text = `
      SELECT * FROM ${ARCHIVE_EVENT_FROM_FSM_PROMISE_TYPE_WORKER_FN}(
        $1::text,
        $2::text,
        $3::text,
        $4::bigint,
        $5::text,
        $6::text,
        $7::jsonb,
        $8::integer,
        $9::uuid,
        $10::text,
        $11::timestamptz,
        $12::integer,
        $13::timestamptz,
        $14::text,
        $15::jsonb,
        $16::text
      ) AS result;
    `;
    const values = [
      promise_queue_name,
      promise_queue_type,
      promise_queue_version,
      promise_queue_msg_id,
      event_name,
      event_action_type,
      toJsonbParam(event_data),
      event_delay,
      send_to_parent_queue_id,
      send_to_parent_queue_id_event_name,
      execution_started_at,
      execution_duration,
      execution_finished_at,
      event_status,
      toJsonbParam(event_output),
      error_message,
    ];
    const res = await deps.db.query<{ result: Json }>(text, values);
    return res.rows?.[0]?.result ?? null;
  } catch (err) {
    console.error("Error in archiveEventFromFsmPromiseTypeWorker:", err);
    throw new Error("Failed to archive event from FSM promise type worker", { cause: err });
  }
}


export async function getFSMData(
  deps: DBDeps,
  id: FsmInstanceRow["id"],
): Promise<FsmInstanceRow | null> {
  try {
    const text = `
      SELECT *
      FROM ${FSM_INSTANCE_TABLE}
      WHERE id = $1::text
      LIMIT 1;
    `;
    const result = await deps.db.query<FsmInstanceRow>(text, [id]);
    if (Array.isArray(result.rows) && result.rows.length > 0) {
      return result.rows[0] ?? null;
    }
    return null;
  } catch (err) {
    console.error("Error in getFSMData:", err);
    throw new Error("Failed to get FSM data", { cause: err });
  }
}


export async function getFsmDataResolveStateValue(
  deps: DBDeps,
  input_fsm_id: FsmInstanceRow["id"],
): Promise<{ fsm_instance_row: FsmInstanceRow; resolved_state_value: Json } | null> {
  try {
    const text = `
      SELECT ${GET_FSM_DATA_RESOLVE_STATE_VALUE_FN}($1::text) AS result;
    `;
    const res = await deps.db.query<{ result: { fsm_instance_row: FsmInstanceRow; resolved_state_value: Json } }>(text, [input_fsm_id]);
    if (!res.rows || res.rows.length === 0) return null;
    return res.rows[0]?.result ?? null;
  } catch (err) {
    console.error("Error in getFsmDataResolveStateValue:", err);
    throw new Error("Failed to get FSM data and resolve state value", { cause: err });
  }
}


export async function sendEventToFsmQueueWithEventLogs(
  deps: DBDeps,
  input_fsm_instance_id: SendEventArgs["input_fsm_instance_id"],
  input_fsm_instance_id_fsm_type: SendEventArgs["input_fsm_instance_id_fsm_type"] | null,
  input_fsm_instance_id_fsm_version: SendEventArgs["input_fsm_instance_id_fsm_version"] | null,
  input_send_to_parent_queue_id: SendEventArgs["input_send_to_parent_queue_id"] | null,
  input_send_to_parent_queue_type: SendEventArgs["input_send_to_parent_queue_type"] | null,
  input_send_to_parent_queue_id_event_name: SendEventArgs["input_send_to_parent_queue_id_event_name"] | null,
  input_event_name: SendEventArgs["input_event_name"],
  input_event_action_type: SendEventArgs["input_event_action_type"],
  input_event_data: SendEventArgs["input_event_data"],
  input_event_delay: NonNullable<SendEventArgs["input_event_delay"]>,
): Promise<Json> {
  try {
    const text = `
      SELECT ${SEND_EVENT_TO_QUEUE_WITH_EVENT_LOGS_FN}(
        $1::uuid,
        $2::text,
        $3::text,
        $4::uuid,
        $5::text,
        $6::text,
        $7::text,
        $8::text,
        $9::jsonb,
        $10::integer
      ) AS result;
    `;
    const values = [
      input_fsm_instance_id,
      input_fsm_instance_id_fsm_type ?? null,
      input_fsm_instance_id_fsm_version ?? null,
      input_send_to_parent_queue_id ?? null,
      input_send_to_parent_queue_type ?? null,
      input_send_to_parent_queue_id_event_name ?? null,
      input_event_name,
      input_event_action_type ?? 'external',
      toJsonbParam(input_event_data),
      input_event_delay ?? 0,
    ];
    const res = await deps.db.query<{ result: Json }>(text, values);
    return res.rows?.[0]?.result ?? null;
  } catch (err) {
    console.error("Error in sendEventToFsmQueueWithEventLogs:", err);
    throw new Error("Failed to send FSM event", { cause: err });
  }
}

export async function stopEventForFsmWorker(
  deps: DBDeps,
  input_fsm_instance_id: string, // uuid — regen types after migration: DatabaseGenerated["fsm_core"]["Functions"]["stop_event_for_fsm_worker_v2"]["Args"]["input_fsm_instance_id"]
): Promise<Json> {
  try {
    const STOP_EVENT_FN = `${FSM_SCHEMA}.stop_event_for_fsm_worker_${FSM_SCHEMA_FN_VERSION}`;
    const text = `
      SELECT ${STOP_EVENT_FN}(
        $1::uuid
      ) AS result;
    `;
    const res = await deps.db.query<{ result: Json }>(text, [input_fsm_instance_id]);
    return res.rows?.[0]?.result ?? null;
  } catch (err) {
    console.error("Error in stopEventForFsmWorker:", err);
    throw new Error("Failed to stop FSM worker event", { cause: err });
  }
}
