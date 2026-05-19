import type { Database, Json } from "@fsm/db/database.types";
type FsmTransitionRow = Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"];

import type { DBDeps } from "@fsm/db";
import type { FsmQueueMessage } from "./types.ts";

export type FsmModuleDefinition = {
  actions: Record<string, (...args: unknown[]) => unknown> | null;
  guards: Record<string, (...args: unknown[]) => unknown> | null;
  delays: Record<string, (...args: unknown[]) => unknown> | null;
  actors: Record<string, (...args: unknown[]) => unknown> | null;
};

import {
  microstep,
  selectAllTransitions,
} from "@fsm/db";

/**
 * Splits the input array into two arrays based on matching event types.
 * @param total The source array of objects with an event property.
 * @param tobeRemoved The array of event type strings to match.
 * @returns A tuple: [newTotal, removed]
 */
export function splitByEventTypes<T extends { event: { type: string } }>(
  total: T[],
  tobeRemoved: string[],
): [T[], T[]] {
  const newTotal: T[] = [];
  const removed: T[] = [];
  for (const item of total) {
    if (tobeRemoved.includes(item.event.type)) {
      removed.push(item);
    } else {
      newTotal.push(item);
    }
  }
  return [newTotal, removed];
}

/**
 * Splits the input array into two arrays based on matching event.send_event_name_to_parent_queue_id.
 * @param total The source array of objects with an event property.
 * @param tobeRemoved The array of strings to match against send_event_name_to_parent_queue_id.
 * @returns A tuple: [newTotal, removed]
 */
export function splitBySendEventName<
  T extends { event: { send_event_name_to_parent_queue_id: string } },
>(
  total: T[],
  tobeRemoved: string[],
): [T[], T[]] {
  const newTotal: T[] = [];
  const removed: T[] = [];
  for (const item of total) {
    if (tobeRemoved.includes(item.event.send_event_name_to_parent_queue_id)) {
      removed.push(item);
    } else {
      newTotal.push(item);
    }
  }
  return [newTotal, removed];
}

// Helper function to process a message for a given queue
// This function should be pure and reusable for different message processing logic
//
// @param deps - DBDeps for database access
// @param queueName - The name of the queue
// @param msg - The message object to process
// @returns Promise<void>
// Helper: run an action implementation from an actions module.
export async function runActionImplementation(
  actionKind: "exit" | "transition" | "entry",
  action: Json,
  actionsModule: Record<string, (...args: unknown[]) => unknown> | null | undefined,
  current_context: Json,
  meta: { deps: DBDeps; queueName: string; msg: Database["pgmq"]["CompositeTypes"]["message_record"] },
): Promise<Json> {
  console.log(`Running ${actionKind} action:`, action);
  try {
    const actionName = action.type || action.action_type || action.name;
    if (actionsModule && typeof actionsModule[actionName] === "function") {
      const result = await actionsModule[actionName](
        current_context,
        action.params || {},
        meta,
      );
      if (typeof result !== "undefined") {
        return result;
      } else {
        return current_context;
      }
    }
  } catch (err) {
    console.error(`Error executing ${actionKind} action implementation:`, err);
  }
  return current_context;
}

// Main function to process a message for a given queue
export async function macrostepV2(
  deps: DBDeps,
  queueName: string,
  msg: Database["pgmq"]["CompositeTypes"]["message_record"],
  fsmInstanceRow: Database["fsm_core"]["Tables"]["fsm_instance"]["Row"],
  resolvedStateValue: Json,
  fsmName: string,
  fsmVersion: number | string,
  fsmModuleDefinition?: FsmModuleDefinition,
): Promise<any> {
  const resolvedState = resolvedStateValue as { json: Json; all_nodes: string[] };
  // Simulate work (replace with real logic)
  await new Promise<void>((resolve) => setTimeout(resolve, 500));

  const msgData = msg.message as unknown as FsmQueueMessage;
  const eventType = msgData.event_data?.event_type;
  const eventPayload = msgData.event_data?.event_payload ?? {};

  const macroSaveFnPayload = {
    remove_from_current_fsm_instance_queue_id: queueName,
    remove_current_queue_msg_id: msg.msg_id,
    remove_schedule_queue_msg_ids: [] as any,
    remove_promise_queue_msg_ids: [] as any,
    new_schedule_queue_data: [] as any,
    new_promise_queue_data: [] as any,
    total_schedule_queue_data: [] as any,
    total_promise_queue_data: [] as any,
    fsm_instance_data_save_fsm_status: {},
    fsm_instance_data_save_fsm_state: {},
    fsm_instance_data_save_fsm_context: {} as any,
    fsm_instance_data_save_fsm_error: {},
    fsm_instance_data_save_fsm_output: {},
    fsm_instance_data_save_fsm_xstate_state: {},
    exit_actions: [] as any,
    transition_actions: [] as any,
    entry_actions: [] as any,
  };

  let current_context = fsmInstanceRow?.fsm_instance_context;
  // pass cuurent_context to all actions and update its value after every action execution
  let total_schedule_queue_data = fsmInstanceRow?.total_schedule_queue_data ||
    [] as any;
  let total_promise_queue_data = fsmInstanceRow?.total_promise_queue_data ||
    [] as any;

  let remove_schedule_queue_msg_ids_xstate = [] as any;
  let remove_promise_queue_msg_ids_xstate = [] as any;
  let new_schedule_queue_data = [] as any;
  let new_promise_queue_data = [] as any;

  let selectedTransition;
  if (eventType === "initialTransition_event") {
    selectedTransition = null;
  } else {
    const allTransitions = (await selectAllTransitions(
      deps,
      eventType,
      resolvedState.all_nodes,
      fsmName,
      fsmVersion.toString(),
    )) as FsmTransitionRow[] | null;
    if (!allTransitions || allTransitions.length === 0) {
      console.error("No transitions found for the given FSM name and version.");
      // TODO check if eventType is xstate.error.actor  we may want to pust FSM to error state
      // stateUtils.ts > code 1676 to 1685 for reference on how to handle xstate.error.actor event
      return;
    } else if (allTransitions.length === 1) {
      selectedTransition = allTransitions[0];
    } else {
      // iterate through all transitions and evaluate guard conditions
      const filteredTransitions: FsmTransitionRow[] = [];
      for (const transition of allTransitions) {
        if (typeof transition.cond === "string") {
          if (transition.cond === "true") filteredTransitions.push(transition);
        } else if (
          typeof transition.cond === "object" && transition.cond !== null
        ) {
          const condObj = transition.cond as any;
          if (condObj.type) {
            const guardFn = fsmModuleDefinition?.guards?.[condObj.type];
            if (typeof guardFn === "function") {
              const eval_result = await (guardFn as Function)(
                current_context,
                condObj,
                { deps, queueName, msg },
              );
              if (eval_result) filteredTransitions.push(transition);
            } else {
              console.error(`Guard function "${condObj.type}" not found in module.`);
            }
          } else {
            console.error("Condition object does not have a type key:", condObj);
          }
        } else {
          console.error("Condition is neither string nor object:", transition.cond);
        }
      }

      if (filteredTransitions.length === 0) {
        console.error(
          "No valid transitions found for the given event and state.",
        );
        return;
      } else if (filteredTransitions.length > 1) {
        console.error(
          "Multiple valid transitions found for the given event and state. Ambiguous transition.",
        );
        return;
      } else {
        console.log("Selected Transition:", filteredTransitions[0]);
        selectedTransition = filteredTransitions[0];
      }
    }
  }

  const microstepResult = await microstep(
    deps,
    selectedTransition,
    eventType,
    resolvedStateValue.all_nodes,
    fsmName,
    fsmVersion.toString(),
  );

  const exit_actions = microstepResult.exit_actions || [];
  for (const action of exit_actions) {
    // find actions implementations and execute fn
    // do comapre based on type or action_type
    // example  // type === xstate.raise or action_type === raise
    if (action.type === "xstate.raise") { // TODO: update action_type
      remove_schedule_queue_msg_ids_xstate.push(action);
    } else if (action.type === "xstate.invoke") { //
      // this is equivalent to xstate.stopChild from worker-helper.ts
      remove_promise_queue_msg_ids_xstate.push(action);
    } else {
      // fsm events - try to execute implementation from actionsModule
      current_context = await runActionImplementation(
        "exit",
        action,
        fsmModuleDefinition?.actions,
        current_context,
        { deps, queueName, msg },
      );
    }
  }
  const transition_actions = microstepResult.transition_actions || [];
  for (const action of transition_actions) {
    // find actions implementations and execute fn
    // action_type === invoke or type === xstate.invoke
    current_context = await runActionImplementation(
      "transition",
      action,
      fsmModuleDefinition?.actions,
      current_context,
      { deps, queueName, msg },
    );
  }

  const entry_actions = microstepResult.entry_actions || [];
  for (const action of entry_actions) {
    // find actions implementations and execute fn
    // do comapre based on type or  action_type
    // example  // type === xstate.raise or action_type === raise
    if (action.type === "xstate.raise") { //
      // update macroSaveFnPayload for new schedule queue data
      const delay = action.params?.delay || 5000000;
      new_schedule_queue_data.push({
        ...action,
        "delay": delay,
        "type": action.type,
      });
    } else if (action.type === "xstate.invoke") {
      // this is equivalent to xstate.spawnChild from worker-helper.ts
      new_promise_queue_data.push({ ...action, "type": action.type });
    } else {
      // fsm events - try to execute implementation from actionsModule
      current_context = await runActionImplementation(
        "entry",
        action,
        fsmModuleDefinition?.actions,
        current_context,
        { deps, queueName, msg },
      );
    }
  }

  // remove msg.message?.type from remove_schedule_queue_msg_ids_xstate because msg.message?.type will be removed from current queue it self in step 6 of save micro fn
  remove_schedule_queue_msg_ids_xstate = remove_schedule_queue_msg_ids_xstate
    .filter((item: any) => item !== (msg.message as unknown as FsmQueueMessage)?.event_data?.event_payload);

  // get both removed and new_total_schedule_queue_data
  // const [new_total_schedule_queue_data, remove_schedule_queue_msg_ids] = splitByEventTypes(total_schedule_queue_data, remove_schedule_queue_msg_ids_xstate);

  // macroSaveFnPayload.remove_schedule_queue_msg_ids = remove_schedule_queue_msg_ids;
  // macroSaveFnPayload.total_schedule_queue_data = new_total_schedule_queue_data;
  // macroSaveFnPayload.new_schedule_queue_data = new_schedule_queue_data;

  macroSaveFnPayload.remove_schedule_queue_msg_ids =
    remove_schedule_queue_msg_ids_xstate;
  macroSaveFnPayload.new_schedule_queue_data = new_schedule_queue_data;
  macroSaveFnPayload.total_schedule_queue_data = total_schedule_queue_data;

  // cancle ivnoke of previous state's children ( PATCH )
  // const [new_total_promise_queue_data, remove_promise_queue_msg_ids] =  splitBySendEventName(total_promise_queue_data, remove_promise_queue_msg_ids_xstate);

  // // remove current promise event from total_promise_queue_data if it is executing xstate.done.actor or xstate.error.actor events
  // let removeEventName;
  // removeEventName = eventType.replace("xstate.done.actor.", "");
  // removeEventName = removeEventName.replace("xstate.error.actor.", "");
  // const update_new_total_promise_queue_data = new_total_promise_queue_data.filter((item)=> item.event.send_event_name_to_parent_queue_id !== removeEventName);

  // macroSaveFnPayload.remove_promise_queue_msg_ids = remove_promise_queue_msg_ids;
  // macroSaveFnPayload.total_promise_queue_data = update_new_total_promise_queue_data;
  // macroSaveFnPayload.new_promise_queue_data = new_promise_queue_data;

  macroSaveFnPayload.remove_promise_queue_msg_ids =
    remove_promise_queue_msg_ids_xstate;
  macroSaveFnPayload.new_promise_queue_data = new_promise_queue_data;
  macroSaveFnPayload.total_promise_queue_data = total_promise_queue_data;

  macroSaveFnPayload.fsm_instance_data_save_fsm_context = current_context;

  // BUG fixed microstepResult.updated_state_value will return json value with 'machine' as root key of object.
  // while in xstate it will return state value without 'machine' as root key of object.
  // example: microstepResult.updated_state_value = { machine: { creditCheck: 'Verifying_Credentials' } }
  // while xstate nextState.value = { creditCheck: 'Verifying_Credentials' }
  // so while returing state value from microstepResult we need to remove 'machine' root key to make it compatible with xstate state value.
  macroSaveFnPayload.fsm_instance_data_save_fsm_state = microstepResult
    .updated_state_value?.machine;

  macroSaveFnPayload.fsm_instance_data_save_fsm_status = "active"; // "active" | "done" | "error" | "stopped"
  macroSaveFnPayload.fsm_instance_data_save_fsm_error = {};
  macroSaveFnPayload.fsm_instance_data_save_fsm_output = {};

  macroSaveFnPayload.fsm_instance_data_save_fsm_xstate_state = microstepResult?.updated_state_value ?? null;

  macroSaveFnPayload.exit_actions = exit_actions;
  macroSaveFnPayload.transition_actions = transition_actions;
  macroSaveFnPayload.entry_actions = entry_actions;

  return macroSaveFnPayload;
}
