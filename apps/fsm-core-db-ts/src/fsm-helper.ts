import type { DBDeps } from "./custom-type.ts";
import { FSM_SCHEMA, FSM_SCHEMA_FN_VERSION } from "./const.ts";
import { toJsonbParam } from "./pg-utils.ts";


// TODO:  load_fsm_state_from_json_v2 fn

/**
 * Calls the load_fsm_state_from_json_v2 SQL function to load FSM state from JSON.
 * @param deps - DBDeps for database access
 * @param json_input - The FSM state JSONB input
 * @param root_node_text - The root node text (can be null)
 * @param fsm_name - The FSM name/identifier
 * @param fsm_version - The FSM version
 * @returns Promise<unknown> - The result from the SQL function
 */
export async function loadFsmStateFromJsonV2(
  deps: DBDeps,
  json_input: unknown,
  root_node_text: string | null,
  fsm_name: string,
  fsm_version: string,
): Promise<unknown> {
  try {
    const LOAD_FSM_STATE_FN = `${FSM_SCHEMA}.load_fsm_state_from_json_${FSM_SCHEMA_FN_VERSION}`;
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
      fsm_name,
      fsm_version,
    ];
    const res = await deps.db.query<{ result: unknown }>(text, values);
    return res.rows?.[0]?.result ?? null;
  } catch (err) {
    console.error("Error in loadFsmStateFromJsonV2:", err);
    throw new Error("Failed to load FSM state from JSON", { cause: err });
  }
}

/**
 * Calls the load_fsm_transition_from_json_v2 SQL function to load FSM transitions from JSON.
 * @param deps - DBDeps for database access
 * @param json_input - The FSM transition JSONB input
 * @param root_node_text - The root node text (can be null)
 * @param fsm_name - The FSM name/identifier
 * @param fsm_version - The FSM version
 * @returns Promise<unknown> - The result from the SQL function
 */
export async function loadFsmTransitionFromJsonV2(
  deps: DBDeps,
  json_input: unknown,
  root_node_text: string | null,
  fsm_name: string,
  fsm_version: string,
): Promise<unknown> {
  try {
    const LOAD_FSM_TRANSITION_FN = `${FSM_SCHEMA}.load_fsm_transition_from_json_${FSM_SCHEMA_FN_VERSION}`;
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
    const res = await deps.db.query<{ result: unknown }>(text, values);
    return res.rows?.[0]?.result ?? null;
  } catch (err) {
    console.error("Error in loadFsmTransitionFromJsonV2:", err);
    throw new Error("Failed to load FSM transition from JSON", { cause: err });
  }
}

export async function loadFsmFromJsonV2(
  deps: DBDeps,
  json_input: unknown,
  root_node_text: string | null,
  fsm_name: string,
  fsm_version: string,
): Promise<unknown> {
  try {
    const LOAD_FSM_FROM_JSON_FN = `${FSM_SCHEMA}.load_fsm_from_json_${FSM_SCHEMA_FN_VERSION}`;
    const text = `
      SELECT ${LOAD_FSM_FROM_JSON_FN}(
        $1::jsonb,
        $2::text,
        $3::text,
        $4::text
      ) AS result;
    `;
    const values = [toJsonbParam(json_input), root_node_text, fsm_name, fsm_version];
    const res = await deps.db.query<{ result: unknown }>(text, values);
    return res.rows?.[0]?.result ?? null;
  } catch (err) {
    console.error("Error in loadFsmFromJsonV2:", err);
    throw new Error("Failed to load FSM from JSON", { cause: err });
  }
}

/**
 * Resolves state value for a given input JSON, FSM name, and FSM version.
 * Calls resolve_state_value_v2 SQL function and returns the result.
 * @param deps - DBDeps for database access
 * @param input_json - The state value JSONB to resolve
 * @param fsm_name - The FSM name/identifier
 * @param fsm_version - The FSM version
 * @returns Promise<{ json: unknown; all_nodes: string[] }> - The resolved state value and all nodes
 */
export async function resolveStateValue(
  deps: DBDeps,
  input_json: unknown,
  fsm_name: string,
  fsm_version: string,
): Promise<{ json: unknown; all_nodes: string[] } | null> {
  try {
    const RESOLVE_STATE_VALUE_FN = `${FSM_SCHEMA}.resolve_state_value_${FSM_SCHEMA_FN_VERSION}`;
    const text = `
      SELECT ${RESOLVE_STATE_VALUE_FN}(
        $1::jsonb,
        $2::text,
        $3::text
      ) AS result;
    `;
    const values = [
      toJsonbParam(input_json),
      fsm_name,
      fsm_version,
    ];
    const res = await deps.db.query<{
      result: { json: unknown; all_nodes: string[] };
    }>(text, values);
    if (!res.rows || res.rows.length === 0) return null;
    return res.rows[0]?.result ?? null;
  } catch (err) {
    console.error("Error in resolveStateValue:", err);
    throw new Error("Failed to resolve state value", { cause: err });
  }
}


export async function performMicrostep(
  deps: DBDeps,
  transition_record?: unknown,
  event_name: string,
  state_value_node_set: unknown,
  fsm_name: string,
  fsm_version: string,
): Promise<{
  updated_state_value_node_set: string[];
  updated_state_value: unknown;
  exit_actions: unknown;
  entry_actions: unknown;
  initial_actions: unknown;
  transition_actions: unknown;
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
      fsm_name,
      fsm_version,
    ];
    const res = await deps.db.query<{ result: {
      updated_state_value_node_set: string[];
      updated_state_value: unknown;
      exit_actions: unknown;
      entry_actions: unknown;
      initial_actions: unknown;
      transition_actions: unknown;
    } }>(text, values);
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
    console.error("Error in performMicrostep:", err);
    throw new Error("Failed to perform microstep", { cause: err });
  }
}

// TODO:
// add fn with name: selectTransitions that will call select_all_transitions
/**
 * Fetches all transitions for a given event, FSM name, and version by calling the SQL function select_all_transitions.
 * @param deps - DBDeps for database access
 * @param event_name - The event name to filter transitions
 * @param source_state_value_set - The source state value set to filter transitions
 * @param fsm_name - The FSM name/identifier
 * @param fsm_version - The FSM version
 * @returns Promise<Array<any>> - Array of transition records
 */
export async function selectTransitions(
  deps: DBDeps,
  event_name: string,
  source_state_value_set: unknown,
  fsm_name: string,
  fsm_version: string,
): Promise<any[]> {
  try {
    const SELECT_TRANSITIONS_FN = `${FSM_SCHEMA}.select_all_transitions_${FSM_SCHEMA_FN_VERSION}`;
    const text = `
      SELECT * FROM ${SELECT_TRANSITIONS_FN}(
        $1::text,
        $2::jsonb,
        $3::text,
        $4::text
      );
    `;
    const values = [
      event_name,
      toJsonbParam(source_state_value_set),
      fsm_name,
      fsm_version,
    ];
    const res = await deps.db.query(text, values);
    return res.rows ?? [];
  } catch (err) {
    console.error("Error in selectTransitions:", err);
    throw new Error("Failed to select transitions", { cause: err });
  }
}
