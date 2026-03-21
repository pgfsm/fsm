import type { DBDeps } from "./custom-type.ts";

import { FSM_SCHEMA, FSM_SCHEMA_FN_VERSION } from "./const.ts";
import { toJsonbParam } from "./pg-utils.ts";

const FSM_INSTANCE_TABLE = `${FSM_SCHEMA}.fsm_instance`;
const CREATE_FSM_INSTANCE_FN = `${FSM_SCHEMA}.create_fsm_instance_from_name_${FSM_SCHEMA_FN_VERSION}`;
const ARCHIVE_EVENT_FROM_FSM_TYPE_WORKER_FN = `${FSM_SCHEMA}.archive_event_from_fsm_type_worker_${FSM_SCHEMA_FN_VERSION}`;
const ARCHIVE_EVENT_FROM_FSM_PROMISE_TYPE_WORKER_FN = `${FSM_SCHEMA}.archive_event_from_fsm_promise_type_worker_${FSM_SCHEMA_FN_VERSION}`;
const GET_FSM_DATA_RESOLVE_STATE_VALUE_FN = `${FSM_SCHEMA}.get_fsm_data_resolve_state_value_${FSM_SCHEMA_FN_VERSION}`;
const SEND_EVENT_TO_QUEUE_WITH_EVENT_LOGS_FN = `${FSM_SCHEMA}.send_event_to_queue_with_event_logs_${FSM_SCHEMA_FN_VERSION}`;


export async function isFSMInstancePresent(
  deps: DBDeps,
  queue: string,
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


/**
 * Creates a new FSM instance from name and version, optionally creates queue and sends initial event.
 * Calls the fsm_core.create_fsm_instance_from_name function.
 */
export async function createFSMInstanceFromName(
  deps: DBDeps,
  fsmName: string,
  fsmVersion: string,
  createQueue = false
): Promise<any> {
  try {
    const text = `
      SELECT ${CREATE_FSM_INSTANCE_FN}(
        $1::text,
        $2::text,
        $3::boolean
      ) AS instance_result;
    `;
    const values = [fsmName, fsmVersion, createQueue];
    const result = await deps.db.query<{ instance_result: unknown }>(
      text,
      values,
    );
    // result.rows[0].instance_result should be the JSONB returned by the function
    return result.rows && result.rows[0] ? result.rows[0].instance_result : null;
  } catch (err) {
    console.error("Error in createFSMInstanceFromName:", err);
    throw new Error("Failed to create FSM instance from name", { cause: err });
  }
}


/**
 * Archives and updates fsm instance state by calling the SQL function archive_event_from_fsm_type_worker.
 * Handles removing/cancelling schedule and promise queue events, sending new events, and updating fsm instance data.
 */
export async function archive_event_from_fsm_type_worker(
  deps: DBDeps,
  remove_from_current_fsm_instance_queue_id: string,
  remove_current_queue_msg_id: number,
  remove_schedule_queue_msg_ids: string[] | null,
  remove_promise_queue_msg_ids: any[] | null,
  input_schedule_queue_data: any | null,
  input_promise_queue_data: any | null,
  total_schedule_queue_data: any | null,
  total_promise_queue_data: any | null,
  fsm_instance_data_save_fsm_status: any,
  fsm_instance_data_save_fsm_state: any,
  fsm_instance_data_save_fsm_context: any,
  fsm_instance_data_save_fsm_xstate_state: any,
): Promise<any> {
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
    const res = await deps.db.query<{ result: unknown }>(text, values);
    return res.rows?.[0]?.result ?? null;
  } catch (err) {
    console.error("Error in archive_event_from_fsm_type_worker:", err);
    throw new Error("Failed to archive event from FSM type worker", { cause: err });
  }
}

/**
 * Archives and updates promise event state by calling the SQL function archive_event_from_fsm_promise_type_worker.
 * Handles removing event from promise queue, sending to parent queue, and logging event.
 */
export async function archive_event_from_fsm_promise_type_worker(
  deps: DBDeps,
  promise_queue_name: string,
  queue_msg_id: number,
  send_to_parent_queue_id: string,
  send_event_name_to_parent_queue_id: string,
  event_output: object,
  event_status: string = "completed",
  event_duration: number | null = null,
  event_finished_at: string | null = null,
): Promise<any> {
  try {
    const text = `
      SELECT * FROM ${ARCHIVE_EVENT_FROM_FSM_PROMISE_TYPE_WORKER_FN}(
        $1::text,
        $2::bigint,
        $3::text,
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
    const res = await deps.db.query<{ result: unknown }>(text, values);
    return res.rows?.[0]?.result ?? null;
  } catch (err) {
    console.error("Error in archive_event_from_fsm_promise_type_worker:", err);
    throw new Error("Failed to archive event from FSM promise type worker", { cause: err });
  }
}

// TODO:
/**
 * Fetches all data from workflow_instance table for a given id.
 * @param deps - DBDeps containing either supabase or drizzle client
 * @param id - The workflow_instance id (UUID) to look up
 * @returns Promise<Database["public"]["Tables"]["workflow_instance"]["Row"] | null> - The workflow_instance row if found, otherwise null
 */
export async function getFSMData(
  deps: DBDeps,
  id: string,
): Promise<any | null> {
  try {
    const text = `
      SELECT *
      FROM ${FSM_INSTANCE_TABLE}
      WHERE id = $1::text
      LIMIT 1;
    `;
    const result = await deps.db.query(text, [id]);
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
  id: string,
): Promise<{ fsm_instance_row: any; resolved_state_value: unknown } | null> {
  try {
    const text = `
      SELECT ${GET_FSM_DATA_RESOLVE_STATE_VALUE_FN}($1::text) AS result;
    `;
    const res = await deps.db.query<{ result: unknown }>(text, [id]);
    if (!res.rows || res.rows.length === 0) return null;
    return res.rows[0]?.result ?? null;
  } catch (err) {
    console.error("Error in getFSMDataAndResolveStateValue:", err);
    throw new Error("Failed to get FSM data and resolve state value", { cause: err });
  }
}


export async function sendFSMEvent(
  deps: DBDeps,
  input_msg: unknown,
  input_event_source: unknown,
  input_delay: number = 0,
  input_event_name?: string,
  input_fsm_instance_id?: string
): Promise<{
  event_data: unknown;
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
