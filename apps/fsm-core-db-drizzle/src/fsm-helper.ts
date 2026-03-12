import { sql } from "drizzle-orm";

import type { DBDeps } from "./custom-type.ts";
import { FSM_SCHEMA, FSM_SCHEMA_FN_VERSION } from "./const.ts";


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
    const query = sql`
      SELECT ${sql.raw(LOAD_FSM_STATE_FN)}(
        ${json_input}::jsonb,
        ${root_node_text}::text,
        ${fsm_name}::text,
        ${fsm_version}::text
      ) AS result;
    `;
    const res = await deps.db.execute(query);
    return res.rows?.[0]?.result ?? null;
  } catch (err) {
    console.error("Error in loadFsmStateFromJsonV2:", err);
    return null;
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
    const query = sql`
      SELECT ${sql.raw(LOAD_FSM_TRANSITION_FN)}(
        ${json_input}::jsonb,
        ${root_node_text}::text,
        ${fsm_name}::text,
        ${fsm_version}::text
      ) AS result;
    `;
    const res = await deps.db.execute(query);
    return res.rows?.[0]?.result ?? null;
  } catch (err) {
    console.error("Error in loadFsmTransitionFromJsonV2:", err);
    return null;
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
    const query = sql`
      SELECT ${sql.raw(RESOLVE_STATE_VALUE_FN)}(
        ${input_json}::jsonb,
        ${fsm_name}::text,
        ${fsm_version}::text
      ) AS result;
    `;
    const res = await deps.db.execute(query);
    if (!res.rows || res.rows.length === 0) return null;
    return res.rows[0]?.result ?? null;
  } catch (err) {
    console.error("Error in resolveStateValue:", err);
    return null;
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
    const query = sql`
      SELECT * FROM ${sql.raw(MICROSTEP_FN)}(
        ${transitionRecordJson}::jsonb,
        ${event_name}::text,
        ${stateValueNodeArray}::text[],
        ${fsm_name}::text,
        ${fsm_version}::text
      );
    `;
    const res = await deps.db.execute(query);
    return (
      res.rows?.[0] ?? {
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
    return {
      updated_state_value_node_set: [],
      updated_state_value: null,
      exit_actions: null,
      entry_actions: null,
      initial_actions: null,
      transition_actions: null,
    };
  }
}

// TODO:
// add fn with name: selectTransitions that will call select_all_transitions
/**
 * Fetches all transitions for a given event, FSM name, and version by calling the SQL function select_all_transitions.
 * @param deps - DBDeps for database access
 * @param event_name - The event name to filter transitions
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
    const query = sql`
      SELECT * FROM ${sql.raw(SELECT_TRANSITIONS_FN)}(
        ${event_name}::text,
        ${source_state_value_set}::jsonb,
        ${fsm_name}::text,
        ${fsm_version}::text
      );
    `;
    const res = await deps.db.execute(query);
    return res.rows ?? [];
  } catch (err) {
    console.error("Error in selectTransitions:", err);
    return [];
  }
}
