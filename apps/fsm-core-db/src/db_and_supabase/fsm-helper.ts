import type { Database } from "../database.types.ts";
import type { DBDeps } from "./custom-type.ts";
export type { DBDeps } from "./custom-type.ts";

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
  // Normalize inputs to avoid sending NULL/undefined as SQL identifiers
  const rpcQueueId = remove_from_current_fsm_instance_queue_id &&
      remove_from_current_fsm_instance_queue_id !== ""
    ? remove_from_current_fsm_instance_queue_id
    : null;

  const safeRemoveSchedule = Array.isArray(remove_schedule_queue_msg_ids)
    ? remove_schedule_queue_msg_ids
    : remove_schedule_queue_msg_ids ?? null;
  const safeRemovePromise = Array.isArray(remove_promise_queue_msg_ids)
    ? remove_promise_queue_msg_ids
    : remove_promise_queue_msg_ids ?? null;
  const safeInputSchedule = input_schedule_queue_data ?? null;
  const safeInputPromise = input_promise_queue_data ?? null;
  const safeTotalSchedule = total_schedule_queue_data ?? null;
  const safeTotalPromise = total_promise_queue_data ?? null;

  if (deps.useSupabase) {
    const { data, error } = await deps.supabase.rpc(
      "archive_event_from_fsm_type_worker",
      {
        remove_from_current_fsm_instance_queue_id: rpcQueueId,
        remove_current_queue_msg_id: remove_current_queue_msg_id,

        to_be_removed_schedule_queue_msg_ids: safeRemoveSchedule,
        to_be_removed_promise_queue_msg_ids: safeRemovePromise,

        to_be_added_schedule_queue_data: safeInputSchedule,
        to_be_added_promise_queue_data: safeInputPromise,

        input_total_schedule_queue_data: safeTotalSchedule,
        input_total_promise_queue_data: safeTotalPromise,

        fsm_instance_data_save_fsm_status: fsm_instance_data_save_fsm_status,
        fsm_instance_data_save_fsm_state: fsm_instance_data_save_fsm_state,
        fsm_instance_data_save_fsm_context: fsm_instance_data_save_fsm_context,
        fsm_instance_data_save_fsm_xstate_state:
          fsm_instance_data_save_fsm_xstate_state,
      },
    );
    if (error) throw error;
    return data;
  } else {
    // For direct SQL, convert arrays and objects to JSON strings as needed
    const res = await deps.db.execute(
      `SELECT * FROM public.archive_event_from_fsm_type_worker(
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
      );`,
      [
        remove_from_current_fsm_instance_queue_id,
        remove_current_queue_msg_id,
        remove_schedule_queue_msg_ids,
        JSON.stringify(remove_promise_queue_msg_ids),
        JSON.stringify(input_schedule_queue_data),
        JSON.stringify(input_promise_queue_data),
        JSON.stringify(total_schedule_queue_data),
        JSON.stringify(total_promise_queue_data),
        JSON.stringify(fsm_instance_data_save_fsm_status),
        JSON.stringify(fsm_instance_data_save_fsm_state),
        JSON.stringify(fsm_instance_data_save_fsm_context),
        JSON.stringify(fsm_instance_data_save_fsm_xstate_state),
      ],
    );
    // The function returns a single row with a jsonb result
    return res.rows?.[0] ?? null;
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
  if (deps.useSupabase) {
    const { data, error } = await deps.supabase.rpc(
      "archive_event_from_fsm_promise_type_worker",
      {
        promise_queue_name,
        queue_msg_id,
        send_to_parent_queue_id,
        send_event_name_to_parent_queue_id,
        event_output,
        event_status,
        event_duration,
        event_finished_at,
      },
    );
    if (error) throw error;
    return data;
  } else {
    // For direct SQL, convert objects to JSON strings as needed
    const res = await deps.db.execute(
      `SELECT * FROM public.archive_event_from_fsm_promise_type_worker(
        $1, $2, $3, $4, $5, $6, $7, $8
      );`,
      [
        promise_queue_name,
        queue_msg_id,
        send_to_parent_queue_id,
        send_event_name_to_parent_queue_id,
        JSON.stringify(event_output),
        event_status,
        event_duration,
        event_finished_at,
      ],
    );
    return res.rows?.[0] ?? null;
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
): Promise<Database["public"]["Tables"]["fsm_instance"]["Row"] | null> {
  if (deps.useSupabase) {
    const { data, error } = await deps.supabase
      .from("fsm_instance")
      .select("*")
      .eq("id", id)
      .limit(1);
    if (error) {
      console.error("Error fetching fsm_instance (supabase):", error);
      return null;
    }
    return data?.[0] ?? null;
  } else {
    const result = await deps.db.execute(
      `SELECT * FROM fsm_instance WHERE id = '${id}' LIMIT 1;`,
    );
    if (Array.isArray(result.rows) && result.rows.length > 0) {
      return result.rows[0] ?? null;
    }
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
  if (deps.useSupabase) {
    const { data, error } = await deps.supabase.rpc("resolve_state_value_v2", {
      input_json,
      input_fsm_name: fsm_name,
      input_fsm_version: fsm_version,
    });
    if (error) throw error;
    if (!data) return null;
    // If data is an array (rare), take the first element
    if (Array.isArray(data)) return data[0] ?? null;
    return data;
  } else {
    // For direct SQL, use parameterized query for safety
    const res = await deps.db.execute(
      `SELECT public.resolve_state_value_v2($1::jsonb, $2::text, $3::text) AS result;`,
      [input_json, fsm_name, fsm_version],
    );
    if (!res.rows || res.rows.length === 0) return null;
    // The result is in res.rows[0].result as a JSON object
    return res.rows[0]?.result ?? null;
  }
}

export async function getFSMDataAndResolveStateValue(
  deps: DBDeps,
  id: string,
): Promise<
  {
    fsm_instance_row: Database["public"]["Tables"]["fsm_instance"]["Row"];
    resolved_state_value: unknown;
  } | null
> {
  if (deps.useSupabase) {
    const { data, error } = await deps.supabase.rpc(
      "get_fsm_data_resolve_state_value_v2",
      {
        input_fsm_id: id,
      },
    );
    if (error) throw error;
    // Supabase returns the JSONB result directly as data
    if (!data) return null;
    // If data is an array (rare), take the first element
    if (Array.isArray(data)) return data[0] ?? null;
    return data;
  } else {
    // For direct SQL, call the function with the id
    const res = await deps.db.execute(
      `SELECT public.get_fsm_data_resolve_state_value_v2($1) AS result;`,
      [id],
    );
    if (!res.rows || res.rows.length === 0) return null;
    // The result is in res.rows[0].result as a JSON object
    return res.rows[0]?.result ?? null;
  }
}

/**
 * Sends a single event to the queue using send_event_to_queue_with_event_logs_v2.
 * @param deps - DBDeps for database access
 * @param input_msg - The event payload (JSON)
 * @param input_event_source - The event source (JSON)
 * @param input_delay - Delay in seconds (optional, default 0)
 * @param input_event_name - Event name (optional)
 * @param input_workflow_instance_id - Workflow instance UUID (required)
 * @returns Promise<{ event_data: unknown; fsm_instance_queue_name: string; fsm_instance_queue_msg_id: number; fsm_instance_queue_event_logs_id: string }>
 */
export async function sendFSMEvent(
  deps: DBDeps,
  input_msg: unknown,
  input_event_source: unknown,
  input_delay: number = 0,
  input_event_name?: string,
  input_fsm_instance_id?: string,
): Promise<{
  event_data: unknown;
  fsm_instance_queue_name: string;
  fsm_instance_queue_msg_id: number;
  fsm_instance_queue_event_logs_id: string;
}> {
  if (!input_fsm_instance_id) {
    throw new Error("input_fsm_instance_id is required");
  }
  if (deps.useSupabase) {
    const { data, error } = await deps.supabase.rpc(
      "send_event_to_queue_with_event_logs_v2",
      {
        input_msg,
        input_event_source,
        input_event_name,
        input_event_delay: input_delay,
        input_fsm_instance_id,
      },
    );
    if (error) throw error;
    // Supabase returns an array of rows, but this function only returns one row
    return data;
  } else {
    // For direct SQL, use parameterized query for safety
    const res = await deps.db.execute(
      `SELECT * FROM public.send_event_to_queue_with_event_logs_v2($1::jsonb, $2::jsonb, $3::text, $4::integer, $5::uuid);`,
      [
        input_msg,
        input_event_source,
        input_event_name,
        input_delay,
        input_fsm_instance_id,
      ],
    );
    return res.rows?.[0] ??
      {
        event_data: null,
        fsm_instance_queue_name: "",
        fsm_instance_queue_msg_id: 0,
        fsm_instance_queue_event_logs_id: "",
      };
  }
}

// add fn microstep_v2
// ...existing code...

/**
 * Performs a single FSM microstep by calling the SQL function microstep_v2.
 * Executes a state transition based on an event and returns updated state information.
 * @param deps - DBDeps for database access
 * @param event_name - The event name triggering the transition
 * @param p_state_value - Current state value (JSONB)
 * @param fsm_name - The FSM name/identifier
 * @param fsm_version - The FSM version
 * @returns Promise with updated state node set, state value, and all actions (exit, entry, initial, transition)
 */
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
  if (deps.useSupabase) {
    const { data, error } = await deps.supabase.rpc("microstep_v2", {
      transition_record: transition_record ?? null,
      event_name,
      state_value_node_set: state_value_node_set,
      fsm_name_param: fsm_name,
      fsm_version_param: fsm_version,
    });
    if (error) throw error;
    return data ?? {
      updated_state_value_node_set: [],
      updated_state_value: null,
      exit_actions: null,
      entry_actions: null,
      initial_actions: null,
      transition_actions: null,
    };
  } else {
    // For direct SQL, use parameterized query for safety
    const res = await deps.db.execute(
      `SELECT * FROM public.microstep_v2($1::jsonb, $2::text, $3::jsonb, $4::text, $5::text);`,
      [
        ,
        transition_record ?? null,
        event_name,
        state_value_node_set,
        fsm_name,
        fsm_version,
      ],
    );
    return res.rows?.[0] ?? {
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
  if (deps.useSupabase) {
    const { data, error } = await deps.supabase.rpc("select_all_transitions", {
      event_name,
      p_state_value: source_state_value_set,
      fsm_name_param: fsm_name,
      fsm_version_param: fsm_version,
    });
    if (error) throw error;
    return data ?? [];
  } else {
    // For direct SQL, use parameterized query for safety
    const res = await deps.db.execute(
      `SELECT * FROM public.select_all_transitions($1::text, $2::jsonb, $3::text, $4::text);`,
      [event_name, source_state_value_set, fsm_name, fsm_version],
    );
    return res.rows ?? [];
  }
}
