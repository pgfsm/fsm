import { getLogger } from "@logtape/logtape";
import type { Database as DatabaseGenerated, Json } from "../database.types.ts";
import type { DBDeps } from "../custom.types.ts";
import { FSM_SCHEMA, FSM_SCHEMA_FN_VERSION } from "../const.ts";
import { toJsonbParam } from "../pg-utils.ts";

const logger = getLogger(["@pgfsm/db", "async-operation-ctl"]);

const ARCHIVE_EVENT_FROM_FSM_ASYNC_OPERATION_TYPE_WORKER_FN =
  `${FSM_SCHEMA}.archive_event_from_fsm_async_operation_type_worker_${FSM_SCHEMA_FN_VERSION}`;

const FINISH_ASYNC_OPERATION_EVENT_FN =
  `${FSM_SCHEMA}.finish_async_operation_event_${FSM_SCHEMA_FN_VERSION}`;

type FinishAsyncOperationEventArgs = DatabaseGenerated["fsm_core"]["Functions"][
  "finish_async_operation_event_v2"
]["Args"];

/**
 * Finishes an actor's message on its async operation queue (SPEC-011 (a),
 * #533): `completed` by its worker's result, or `cancelled` because its
 * invoking state exited. It archives the message first and acts only when
 * that archive was its own, so a completion and a cancel racing on one
 * message never both act: a completed result is sent to the parent (with its
 * source), a cancel is announced on `fsm_async_operation_cancel`, and the
 * loser is logged as `discarded`.
 */
export async function finishAsyncOperationEvent(
  deps: DBDeps,
  archive_reason: "completed" | "cancelled",
  async_operation_queue_name:
    FinishAsyncOperationEventArgs["input_async_operation_queue_name"],
  async_operation_queue_msg_id:
    FinishAsyncOperationEventArgs["input_async_operation_queue_msg_id"],
  completion: {
    async_operation_queue_type?:
      FinishAsyncOperationEventArgs["input_async_operation_queue_type"];
    async_operation_queue_version?:
      FinishAsyncOperationEventArgs["input_async_operation_queue_version"];
    event_name?: FinishAsyncOperationEventArgs["input_event_name"];
    event_action_type?:
      FinishAsyncOperationEventArgs["input_event_action_type"];
    event_data?: FinishAsyncOperationEventArgs["input_event_data"];
    event_delay?: FinishAsyncOperationEventArgs["input_event_delay"];
    send_to_parent_queue_id?:
      FinishAsyncOperationEventArgs["input_send_to_parent_queue_id"];
    send_to_parent_queue_id_event_name?:
      FinishAsyncOperationEventArgs["input_send_to_parent_queue_id_event_name"];
    execution_started_at?:
      FinishAsyncOperationEventArgs["input_execution_started_at"];
    execution_duration?:
      FinishAsyncOperationEventArgs["input_execution_duration"];
    execution_finished_at?:
      FinishAsyncOperationEventArgs["input_execution_finished_at"];
    event_status?: FinishAsyncOperationEventArgs["input_event_status"];
    event_output?: FinishAsyncOperationEventArgs["input_event_output"];
    error_message?: FinishAsyncOperationEventArgs["input_error_message"] | null;
  } = {},
): Promise<Json> {
  try {
    const text = `
      SELECT ${FINISH_ASYNC_OPERATION_EVENT_FN}(
        input_archive_reason := $1::text,
        input_async_operation_queue_name := $2::text,
        input_async_operation_queue_msg_id := $3::bigint,
        input_async_operation_queue_type := $4::text,
        input_async_operation_queue_version := $5::text,
        input_event_name := $6::text,
        input_event_action_type := $7::text,
        input_event_data := $8::jsonb,
        input_event_delay := $9::integer,
        input_send_to_parent_queue_id := $10::uuid,
        input_send_to_parent_queue_id_event_name := $11::text,
        input_execution_started_at := $12::timestamptz,
        input_execution_duration := $13::integer,
        input_execution_finished_at := COALESCE($14::timestamptz, now()),
        input_event_status := $15::text,
        input_event_output := $16::jsonb,
        input_error_message := $17::text
      ) AS result;
    `;
    const values = [
      archive_reason,
      async_operation_queue_name,
      async_operation_queue_msg_id,
      completion.async_operation_queue_type ?? null,
      completion.async_operation_queue_version ?? null,
      completion.event_name ?? null,
      completion.event_action_type ?? null,
      toJsonbParam(completion.event_data ?? null),
      completion.event_delay ?? 0,
      completion.send_to_parent_queue_id ?? null,
      completion.send_to_parent_queue_id_event_name ?? null,
      completion.execution_started_at ?? null,
      completion.execution_duration ?? null,
      completion.execution_finished_at ?? null,
      completion.event_status ?? null,
      toJsonbParam(completion.event_output ?? null),
      completion.error_message ?? null,
    ];
    const res = await deps.db.query<{ result: Json }>(text, values);
    return res.rows?.[0]?.result ?? null;
  } catch (err) {
    logger.error("Error in finishAsyncOperationEvent: {error}", {
      error: err,
    });
    throw new Error("Failed to finish async-operation event", { cause: err });
  }
}

type ArchiveAsyncOperationWorkerArgs =
  DatabaseGenerated["fsm_core"]["Functions"][
    "archive_event_from_fsm_async_operation_type_worker_v2"
  ]["Args"];

/**
 * @deprecated Use {@link finishAsyncOperationEvent} with `"completed"`
 * (#533). The SQL function is now a wrapper over it.
 */
export async function archiveEventFromFsmAsyncOperationTypeWorker(
  deps: DBDeps,
  async_operation_queue_name:
    ArchiveAsyncOperationWorkerArgs["input_async_operation_queue_name"],
  async_operation_queue_type:
    ArchiveAsyncOperationWorkerArgs["input_async_operation_queue_type"],
  async_operation_queue_version:
    ArchiveAsyncOperationWorkerArgs["input_async_operation_queue_version"],
  async_operation_queue_msg_id:
    ArchiveAsyncOperationWorkerArgs["input_async_operation_queue_msg_id"],
  event_name: ArchiveAsyncOperationWorkerArgs["input_event_name"],
  event_action_type: ArchiveAsyncOperationWorkerArgs["input_event_action_type"],
  event_data: ArchiveAsyncOperationWorkerArgs["input_event_data"],
  event_delay: ArchiveAsyncOperationWorkerArgs["input_event_delay"],
  send_to_parent_queue_id:
    ArchiveAsyncOperationWorkerArgs["input_send_to_parent_queue_id"],
  send_to_parent_queue_id_event_name:
    ArchiveAsyncOperationWorkerArgs["input_send_to_parent_queue_id_event_name"],
  execution_started_at:
    ArchiveAsyncOperationWorkerArgs["input_execution_started_at"],
  execution_duration:
    ArchiveAsyncOperationWorkerArgs["input_execution_duration"],
  execution_finished_at:
    ArchiveAsyncOperationWorkerArgs["input_execution_finished_at"],
  event_status: ArchiveAsyncOperationWorkerArgs["input_event_status"],
  event_output: ArchiveAsyncOperationWorkerArgs["input_event_output"],
  error_message: ArchiveAsyncOperationWorkerArgs["input_error_message"] | null,
): Promise<Json> {
  try {
    const text = `
      SELECT * FROM ${ARCHIVE_EVENT_FROM_FSM_ASYNC_OPERATION_TYPE_WORKER_FN}(
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
      async_operation_queue_name,
      async_operation_queue_type,
      async_operation_queue_version,
      async_operation_queue_msg_id,
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
    logger.error(
      "Error in archiveEventFromFsmAsyncOperationTypeWorker: {error}",
      {
        error: err,
      },
    );
    throw new Error(
      "Failed to archive event from FSM async-operation type worker",
      {
        cause: err,
      },
    );
  }
}
