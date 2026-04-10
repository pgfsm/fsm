import type { Database as DatabaseGenerated, Json } from "./database.types.ts";
import type { DBDeps } from "./custom-type.ts";

import { FSM_SCHEMA, FSM_SCHEMA_FN_VERSION } from "./const.ts";
import { toJsonbParam } from "./pg-utils.ts";

const FSM_INSTANCE_TABLE = `${FSM_SCHEMA}.fsm_instance`;
const CREATE_FSM_INSTANCE_FN = `${FSM_SCHEMA}.create_fsm_instance_from_name_${FSM_SCHEMA_FN_VERSION}`;
const ARCHIVE_EVENT_FROM_FSM_TYPE_WORKER_FN = `${FSM_SCHEMA}.archive_event_from_fsm_type_worker_${FSM_SCHEMA_FN_VERSION}`;
const ARCHIVE_EVENT_FROM_FSM_PROMISE_TYPE_WORKER_FN = `${FSM_SCHEMA}.archive_event_from_fsm_promise_type_worker_${FSM_SCHEMA_FN_VERSION}`;
const GET_FSM_DATA_RESOLVE_STATE_VALUE_FN = `${FSM_SCHEMA}.get_fsm_data_resolve_state_value_${FSM_SCHEMA_FN_VERSION}`;
const SEND_EVENT_TO_QUEUE_WITH_EVENT_LOGS_FN = `${FSM_SCHEMA}.send_event_to_queue_with_event_logs_${FSM_SCHEMA_FN_VERSION}`;

type FsmInstanceRow = DatabaseGenerated["fsm_core"]["Tables"]["fsm_instance"]["Row"];
type ArchiveWorkerArgs = DatabaseGenerated["fsm_core"]["Functions"]["archive_event_from_fsm_type_worker_v2"]["Args"];
type ArchivePromiseWorkerArgs = DatabaseGenerated["fsm_core"]["Functions"]["archive_event_from_fsm_promise_type_worker_v2"]["Args"];
type SendEventArgs = DatabaseGenerated["fsm_core"]["Functions"]["send_event_to_queue_with_event_logs_v2"]["Args"];
type CreateInstanceArgs = DatabaseGenerated["fsm_core"]["Functions"]["create_fsm_instance_from_name_v2"]["Args"];


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


export async function createFSMInstanceFromName(
  deps: DBDeps,
  fsmName: CreateInstanceArgs["input_fsm_name"],
  fsmVersion: CreateInstanceArgs["input_fsm_version"],
  fsmContext: CreateInstanceArgs["input_fsm_context"],
  createQueue: NonNullable<CreateInstanceArgs["create_pgmq_queue"]> = false,
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
    const values = [fsmName, fsmVersion, toJsonbParam(fsmContext), createQueue];
    const result = await deps.db.query<{ instance_result: Json }>(
      text,
      values,
    );
    return result.rows && result.rows[0] ? result.rows[0].instance_result : null;
  } catch (err) {
    console.error("Error in createFSMInstanceFromName:", err);
    throw new Error("Failed to create FSM instance from name", { cause: err });
  }
}


export async function archive_event_from_fsm_type_worker(
  deps: DBDeps,
  remove_from_current_fsm_instance_queue_id: ArchiveWorkerArgs["remove_from_current_fsm_instance_queue_id"],
  remove_current_queue_msg_id: ArchiveWorkerArgs["remove_current_queue_msg_id"],
  remove_schedule_queue_msg_ids: ArchiveWorkerArgs["to_be_removed_schedule_queue_msg_ids"] | null,
  remove_promise_queue_msg_ids: ArchiveWorkerArgs["to_be_removed_promise_queue_msg_ids"] | null,
  input_schedule_queue_data: ArchiveWorkerArgs["to_be_added_schedule_queue_data"] | null,
  input_promise_queue_data: ArchiveWorkerArgs["to_be_added_promise_queue_data"] | null,
  total_schedule_queue_data: ArchiveWorkerArgs["input_total_schedule_queue_data"] | null,
  total_promise_queue_data: ArchiveWorkerArgs["input_total_promise_queue_data"] | null,
  fsm_instance_data_save_fsm_status: ArchiveWorkerArgs["fsm_instance_data_save_fsm_status"],
  fsm_instance_data_save_fsm_state: ArchiveWorkerArgs["fsm_instance_data_save_fsm_state"],
  fsm_instance_data_save_fsm_context: ArchiveWorkerArgs["fsm_instance_data_save_fsm_context"],
  fsm_instance_data_save_fsm_xstate_state: ArchiveWorkerArgs["fsm_instance_data_save_fsm_xstate_state"],
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
        $12::jsonb
      ) AS result;
    `;
    const values = [
      remove_from_current_fsm_instance_queue_id,
      remove_current_queue_msg_id,
      toJsonbParam(remove_schedule_queue_msg_ids),
      toJsonbParam(remove_promise_queue_msg_ids),
      toJsonbParam(input_schedule_queue_data),
      toJsonbParam(input_promise_queue_data),
      toJsonbParam(total_schedule_queue_data),
      toJsonbParam(total_promise_queue_data),
      toJsonbParam(fsm_instance_data_save_fsm_status),
      toJsonbParam(fsm_instance_data_save_fsm_state),
      toJsonbParam(fsm_instance_data_save_fsm_context),
      toJsonbParam(fsm_instance_data_save_fsm_xstate_state),
    ];
    const res = await deps.db.query<{ result: Json }>(text, values);
    return res.rows?.[0]?.result ?? null;
  } catch (err) {
    console.error("Error in archive_event_from_fsm_type_worker:", err);
    throw new Error("Failed to archive event from FSM type worker", { cause: err });
  }
}

export async function archive_event_from_fsm_promise_type_worker(
  deps: DBDeps,
  promise_queue_name: ArchivePromiseWorkerArgs["promise_queue_name"],
  queue_msg_id: ArchivePromiseWorkerArgs["queue_msg_id"] | null,
  send_to_parent_queue_id: ArchivePromiseWorkerArgs["send_to_parent_queue_id"],
  send_event_name_to_parent_queue_id: ArchivePromiseWorkerArgs["send_event_name_to_parent_queue_id"],
  event_output: ArchivePromiseWorkerArgs["event_output"],
  event_status: NonNullable<ArchivePromiseWorkerArgs["event_status"]> = "completed",
  event_duration: ArchivePromiseWorkerArgs["event_duration"] | null = null,
  event_finished_at: ArchivePromiseWorkerArgs["event_finished_at"] | null = null,
): Promise<Json> {
  try {
    const text = `
      SELECT * FROM ${ARCHIVE_EVENT_FROM_FSM_PROMISE_TYPE_WORKER_FN}(
        $1::text,
        $2::bigint,
        $3::uuid,
        $4::text,
        $5::jsonb,
        $6::text,
        $7::integer,
        $8::timestamptz
      ) AS result;
    `;
    const values = [
      promise_queue_name,
      queue_msg_id,
      send_to_parent_queue_id,
      send_event_name_to_parent_queue_id,
      toJsonbParam(event_output),
      event_status,
      event_duration,
      event_finished_at,
    ];
    const res = await deps.db.query<{ result: Json }>(text, values);
    return res.rows?.[0]?.result ?? null;
  } catch (err) {
    console.error("Error in archive_event_from_fsm_promise_type_worker:", err);
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


export async function getFSMDataAndResolveStateValue(
  deps: DBDeps,
  id: FsmInstanceRow["id"],
): Promise<{ fsm_instance_row: FsmInstanceRow; resolved_state_value: Json } | null> {
  try {
    const text = `
      SELECT ${GET_FSM_DATA_RESOLVE_STATE_VALUE_FN}($1::text) AS result;
    `;
    const res = await deps.db.query<{ result: { fsm_instance_row: FsmInstanceRow; resolved_state_value: Json } }>(text, [id]);
    if (!res.rows || res.rows.length === 0) return null;
    return res.rows[0]?.result ?? null;
  } catch (err) {
    console.error("Error in getFSMDataAndResolveStateValue:", err);
    throw new Error("Failed to get FSM data and resolve state value", { cause: err });
  }
}


export async function sendFSMEvent(
  deps: DBDeps,
  input_msg: SendEventArgs["input_msg"],
  input_event_source: SendEventArgs["input_event_source"],
  input_delay: NonNullable<SendEventArgs["input_event_delay"]> = 0,
  input_event_name?: SendEventArgs["input_event_name"],
  input_fsm_instance_id?: SendEventArgs["input_fsm_instance_id"],
): Promise<{
  event_data: Json;
  fsm_instance_queue_name: string;
  fsm_instance_queue_msg_id: number;
  fsm_instance_queue_event_logs_id: string;
}> {
  if (!input_fsm_instance_id) {
    throw new Error('input_fsm_instance_id is required');
  }
  try {
    const text = `
      SELECT * FROM ${SEND_EVENT_TO_QUEUE_WITH_EVENT_LOGS_FN}(
        $1::jsonb,
        $2::jsonb,
        $3::text,
        $4::integer,
        $5::uuid
      );
    `;
    const values = [
      toJsonbParam(input_msg),
      toJsonbParam(input_event_source),
      input_event_name ?? null,
      input_delay,
      input_fsm_instance_id,
    ];
    const res = await deps.db.query(text, values);
    return (
      res.rows?.[0] ?? {
        event_data: null,
        fsm_instance_queue_name: '',
        fsm_instance_queue_msg_id: 0,
        fsm_instance_queue_event_logs_id: '',
      }
    );
  } catch (err) {
    console.error("Error in sendFSMEvent:", err);
    throw new Error("Failed to send FSM event", { cause: err });
  }
}
