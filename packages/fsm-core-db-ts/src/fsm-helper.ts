import { getLogger } from "@logtape/logtape";
import type { Database as DatabaseGenerated, Json } from "./database.types.ts";
import type { DBDeps } from "./custom-type.ts";

const logger = getLogger(["@pgfsm/db", "helper"]);
import { FSM_SCHEMA, FSM_SCHEMA_FN_VERSION } from "./const.ts";
import { toJsonbParam } from "./pg-utils.ts";

export async function loadFsmStateFromJson(
  deps: DBDeps,
  json_input: Json,
  root_node_text: string | null,
  input_fsm_name:
    DatabaseGenerated["fsm_core"]["Functions"]["load_fsm_state_from_json_v2"][
      "Args"
    ]["input_fsm_name"],
  input_fsm_version:
    DatabaseGenerated["fsm_core"]["Functions"]["load_fsm_state_from_json_v2"][
      "Args"
    ]["input_fsm_version"],
): Promise<Json> {
  try {
    const LOAD_FSM_STATE_FN =
      `${FSM_SCHEMA}.load_fsm_state_from_json_${FSM_SCHEMA_FN_VERSION}`;
    const text = `
      SELECT ${LOAD_FSM_STATE_FN}(
        $1::jsonb,
        $2::text,
        $3::text,
        $4::text
      ) AS result;
    `;
    const values = [
      toJsonbParam(json_input),
      root_node_text,
      input_fsm_name,
      input_fsm_version,
    ];
    const res = await deps.db.query<{ result: Json }>(text, values);
    return res.rows?.[0]?.result ?? null;
  } catch (err) {
    logger.error("Error in loadFsmStateFromJson: {error}", { error: err });
    throw new Error("Failed to load FSM state from JSON", { cause: err });
  }
}

export async function loadFsmTransitionFromJson(
  deps: DBDeps,
  json_input: Json,
  root_node_text: string | null,
  fsm_name: DatabaseGenerated["fsm_core"]["Functions"][
    "load_fsm_transition_from_json_v2"
  ]["Args"]["fsm_name"],
  fsm_version: DatabaseGenerated["fsm_core"]["Functions"][
    "load_fsm_transition_from_json_v2"
  ]["Args"]["fsm_version"],
): Promise<Json> {
  try {
    const LOAD_FSM_TRANSITION_FN =
      `${FSM_SCHEMA}.load_fsm_transition_from_json_${FSM_SCHEMA_FN_VERSION}`;
    const text = `
      SELECT ${LOAD_FSM_TRANSITION_FN}(
        $1::jsonb,
        $2::text,
        $3::text,
        $4::text
      ) AS result;
    `;
    const values = [
      toJsonbParam(json_input),
      root_node_text,
      fsm_name,
      fsm_version,
    ];
    const res = await deps.db.query<{ result: Json }>(text, values);
    return res.rows?.[0]?.result ?? null;
  } catch (err) {
    logger.error("Error in loadFsmTransitionFromJson: {error}", { error: err });
    throw new Error("Failed to load FSM transition from JSON", { cause: err });
  }
}

export async function loadFsmFromJson(
  deps: DBDeps,
  json_input: Json,
  root_node_text: string | null,
  input_fsm_type:
    DatabaseGenerated["fsm_core"]["Functions"]["load_fsm_from_json_v2"]["Args"][
      "input_fsm_type"
    ],
  input_fsm_name:
    DatabaseGenerated["fsm_core"]["Functions"]["load_fsm_from_json_v2"]["Args"][
      "input_fsm_name"
    ],
  input_fsm_version:
    DatabaseGenerated["fsm_core"]["Functions"]["load_fsm_from_json_v2"]["Args"][
      "input_fsm_version"
    ],
  input_dependent_children?: Json | null,
): Promise<Json> {
  try {
    const LOAD_FSM_FROM_JSON_FN =
      `${FSM_SCHEMA}.load_fsm_from_json_${FSM_SCHEMA_FN_VERSION}`;
    const text = `
      SELECT ${LOAD_FSM_FROM_JSON_FN}(
        $1::jsonb,
        $2::text,
        $3::text,
        $4::text,
        $5::text,
        $6::jsonb
      ) AS result;
    `;
    const values = [
      toJsonbParam(json_input),
      root_node_text,
      input_fsm_type,
      input_fsm_name,
      input_fsm_version,
      input_dependent_children != null
        ? toJsonbParam(input_dependent_children)
        : null,
    ];
    const res = await deps.db.query<{ result: Json }>(text, values);
    return res.rows?.[0]?.result ?? null;
  } catch (err) {
    logger.error("Error in loadFsmFromJson: {error}", { error: err });
    throw new Error("Failed to load FSM from JSON", { cause: err });
  }
}

export async function resolveStateValue(
  deps: DBDeps,
  input_json: Json,
  input_fsm_name:
    DatabaseGenerated["fsm_core"]["Functions"]["resolve_state_value_v2"][
      "Args"
    ]["input_fsm_name"],
  input_fsm_version:
    DatabaseGenerated["fsm_core"]["Functions"]["resolve_state_value_v2"][
      "Args"
    ]["input_fsm_version"],
): Promise<{ json: Json; all_nodes: string[] } | null> {
  try {
    const RESOLVE_STATE_VALUE_FN =
      `${FSM_SCHEMA}.resolve_state_value_${FSM_SCHEMA_FN_VERSION}`;
    const text = `
      SELECT ${RESOLVE_STATE_VALUE_FN}(
        $1::jsonb,
        $2::text,
        $3::text
      ) AS result;
    `;
    const values = [
      toJsonbParam(input_json),
      input_fsm_name,
      input_fsm_version,
    ];
    const res = await deps.db.query<{
      result: { json: Json; all_nodes: string[] };
    }>(text, values);
    if (!res.rows || res.rows.length === 0) return null;
    return res.rows[0]?.result ?? null;
  } catch (err) {
    logger.error("Error in resolveStateValue: {error}", { error: err });
    throw new Error("Failed to resolve state value", { cause: err });
  }
}

export async function microstep(
  deps: DBDeps,
  transition_record:
    | DatabaseGenerated["fsm_core"]["Tables"]["fsm_transitions"]["Row"]
    | null,
  event_name:
    DatabaseGenerated["fsm_core"]["Functions"]["microstep_v2"]["Args"][
      "event_name"
    ],
  state_value_node_set:
    DatabaseGenerated["fsm_core"]["Functions"]["microstep_v2"]["Args"][
      "state_value_node_set"
    ],
  fsm_name_param:
    DatabaseGenerated["fsm_core"]["Functions"]["microstep_v2"]["Args"][
      "fsm_name_param"
    ],
  fsm_version_param:
    DatabaseGenerated["fsm_core"]["Functions"]["microstep_v2"]["Args"][
      "fsm_version_param"
    ],
): Promise<{
  updated_state_value_node_set: string[];
  updated_state_value: Json;
  exit_actions: Json;
  entry_actions: Json;
  initial_actions: Json;
  transition_actions: Json;
}> {
  try {
    const transitionRecordJson =
      transition_record === undefined || transition_record === null
        ? null
        : JSON.stringify(transition_record);
    const stateValueNodeArray = Array.isArray(state_value_node_set)
      ? state_value_node_set
      : [];
    const MICROSTEP_FN = `${FSM_SCHEMA}.microstep_${FSM_SCHEMA_FN_VERSION}`;
    const text = `
      SELECT * FROM ${MICROSTEP_FN}(
        CASE
          WHEN $1::jsonb IS NULL THEN NULL::${FSM_SCHEMA}.fsm_transitions
          ELSE jsonb_populate_record(NULL::${FSM_SCHEMA}.fsm_transitions, $1::jsonb)
        END,
        $2::text,
        $3::text[],
        $4::text,
        $5::text
      ) AS result;
    `;
    const values = [
      transitionRecordJson,
      event_name,
      stateValueNodeArray,
      fsm_name_param,
      fsm_version_param,
    ];
    const res = await deps.db.query<{
      result: {
        updated_state_value_node_set: string[];
        updated_state_value: Json;
        exit_actions: Json;
        entry_actions: Json;
        initial_actions: Json;
        transition_actions: Json;
      };
    }>(text, values);
    return (
      res.rows?.[0]?.result ?? {
        updated_state_value_node_set: [],
        updated_state_value: null,
        exit_actions: null,
        entry_actions: null,
        initial_actions: null,
        transition_actions: null,
      }
    );
  } catch (err) {
    logger.error("Error in microstep: {error}", { error: err });
    throw new Error("Failed to perform microstep", { cause: err });
  }
}

export async function loadAsyncOperation(
  deps: DBDeps,
  input_async_operation_name: string,
  input_async_operation_version: string,
  input_async_operation_type: string,
  input_async_operation_language: string,
  input_parent_fsm_name: string,
  input_parent_fsm_version: string,
): Promise<Json> {
  try {
    const LOAD_ASYNC_OP_META_FN =
      `${FSM_SCHEMA}.load_async_operation_meta_${FSM_SCHEMA_FN_VERSION}`;
    const text = `
      SELECT ${LOAD_ASYNC_OP_META_FN}(
        $1::text,
        $2::text,
        $3::text,
        $4::text,
        $5::text,
        $6::text
      ) AS result;
    `;
    const values = [
      input_async_operation_name,
      input_async_operation_version,
      input_async_operation_type,
      input_async_operation_language,
      input_parent_fsm_name,
      input_parent_fsm_version,
    ];
    const res = await deps.db.query<{ result: Json }>(text, values);
    return res.rows?.[0]?.result ?? null;
  } catch (err) {
    logger.error("Error in loadAsyncOperation: {error}", { error: err });
    throw new Error("Failed to load async operation", { cause: err });
  }
}

export async function selectAllTransitions(
  deps: DBDeps,
  event_name:
    DatabaseGenerated["fsm_core"]["Functions"]["select_all_transitions_v2"][
      "Args"
    ]["event_name"],
  input_state_value:
    DatabaseGenerated["fsm_core"]["Functions"]["select_all_transitions_v2"][
      "Args"
    ]["input_state_value"],
  fsm_name_param:
    DatabaseGenerated["fsm_core"]["Functions"]["select_all_transitions_v2"][
      "Args"
    ]["fsm_name_param"],
  fsm_version_param:
    DatabaseGenerated["fsm_core"]["Functions"]["select_all_transitions_v2"][
      "Args"
    ]["fsm_version_param"],
): Promise<Json> {
  try {
    const SELECT_TRANSITIONS_FN =
      `${FSM_SCHEMA}.select_all_transitions_${FSM_SCHEMA_FN_VERSION}`;
    const text = `
      SELECT ${SELECT_TRANSITIONS_FN}(
        $1::text,
        $2::text[],
        $3::text,
        $4::text
      ) AS result;
    `;
    const values = [
      event_name,
      input_state_value,
      fsm_name_param,
      fsm_version_param,
    ];
    const res = await deps.db.query<{ result: Json }>(text, values);
    return res.rows?.[0]?.result ?? null;
  } catch (err) {
    logger.error("Error in selectAllTransitions: {error}", { error: err });
    throw new Error("Failed to select transitions", { cause: err });
  }
}
