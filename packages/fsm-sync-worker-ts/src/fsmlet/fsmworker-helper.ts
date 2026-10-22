import { getLogger } from "@logtape/logtape";
import type { Database, Json } from "@pgfsm/db/database.types";
type FsmTransitionRow =
  Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"];

import type { DBDeps } from "@pgfsm/db";

const logger = getLogger(["@pgfsm/worker", "macrostep"]);
const actionsLogger = getLogger(["@pgfsm/worker", "macrostep", "actions"]);
import type { FsmQueueMessage } from "../types.ts";
import type { MacrostepV2Result, SyncOperationRegistration } from "./type.ts";
import { stateValueWithoutRoot } from "./state-value.ts";
import { orderEntryActions } from "./entry-actions.ts";
import { selectTransitions } from "./select-transitions.ts";
import { delayedEventType, resolveRaiseDelay } from "./delays.ts";
import { invokeWithInput } from "./invoke-input.ts";

import { microstep, selectAllTransitions } from "@pgfsm/db";

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

/**
 * Finds a single handler in the compiler-generated sync-operation
 * registrations sub-array (see `sync-operation-registrations.ts`) by type +
 * name — the counterpart of the old `fsmModuleDefinition.actions[name]`/
 * `fsmModuleDefinition.guards[name]` map lookups, now that the worker is
 * handed the raw `SyncOperationRegistration[]` sub-array for this
 * FSM/version rather than pre-grouped `{actions, guards, delays}` maps.
 */
function findSyncOperationHandler(
  registrations: SyncOperationRegistration[] | null | undefined,
  syncOperationType: SyncOperationRegistration["syncOperationType"],
  syncOperationName: string,
): ((...args: unknown[]) => unknown) | undefined {
  return registrations?.find((r) =>
    r.syncOperationType === syncOperationType &&
    r.syncOperationName === syncOperationName
  )?.handler;
}

// Helper function to process a message for a given queue
// This function should be pure and reusable for different message processing logic
//
// @param deps - DBDeps for database access
// @param queueName - The name of the queue
// @param msg - The message object to process
// @returns Promise<void>
// Helper: run an action implementation resolved from the FSM's sync-operation registrations.
export async function runActionImplementation(
  actionKind: "exit" | "transition" | "entry" | "initial",
  action: Json,
  syncOperationRegistrations: SyncOperationRegistration[] | null | undefined,
  current_context: Json,
  meta: {
    deps: DBDeps;
    queueName: string;
    msg: Database["pgmq"]["CompositeTypes"]["message_record"];
  },
): Promise<Json> {
  actionsLogger.info("Running {kind} action: {action}", {
    kind: actionKind,
    action,
  });
  try {
    const actionName = action.type || action.action_type || action.name;
    const handler = findSyncOperationHandler(
      syncOperationRegistrations,
      "action",
      actionName,
    );
    if (typeof handler === "function") {
      const result = await handler(
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
    actionsLogger.error(
      "Error executing {kind} action implementation: {error}",
      { kind: actionKind, error: err },
    );
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
  syncOperationRegistrations?: SyncOperationRegistration[],
): Promise<MacrostepV2Result | undefined> {
  const resolvedState = resolvedStateValue as {
    json: Json;
    all_nodes: string[];
  };
  const msgData = msg.message as unknown as FsmQueueMessage;
  const eventType = msgData.eventData?.eventType;

  if (!eventType) {
    logger.error("No eventType found in message data");
    return;
  }

  const macroSaveFnPayload = {
    remove_from_current_fsm_instance_queue_id: queueName,
    remove_current_queue_msg_id: msg.msg_id,
    to_be_removed_schedule_queue_msg_ids: [] as Json[],
    to_be_removed_async_operation_queue_msg_ids: [] as Json[],
    to_be_added_schedule_queue_data: [] as Json[],
    to_be_added_async_operation_queue_data: [] as Json[],
    input_total_schedule_queue_data: [] as Json[],
    input_total_async_operation_queue_data: [] as Json[],
    fsm_instance_data_save_fsm_status: {},
    fsm_instance_data_save_fsm_state: {},
    fsm_instance_data_save_fsm_context: {} as Json,
    fsm_instance_data_save_fsm_error: null as Json,
    fsm_instance_data_save_fsm_output: {},
    fsm_instance_data_save_fsm_xstate_state: {},
    raised_events: [] as Json[],
    exit_actions: [] as Json[],
    transition_actions: [] as Json[],
    entry_actions: [] as Json[],
  };

  let current_context = fsmInstanceRow?.fsm_instance_context;
  // pass cuurent_context to all actions and update its value after every action execution
  const total_schedule_queue_data =
    (fsmInstanceRow?.total_schedule_queue_data || []) as Json[];
  const total_async_operation_queue_data =
    (fsmInstanceRow?.total_async_operation_queue_data || []) as Json[];

  let remove_schedule_queue_msg_ids_xstate = [] as Json[];
  const remove_async_operation_queue_msg_ids_xstate = [] as Json[];
  const new_schedule_queue_data = [] as Json[];
  const new_async_operation_queue_data = [] as Json[];

  // XState's transition selection (#510): from each active leaf, deepest
  // first, the first candidate whose guard passes, at most one per region.
  let selectedTransition: FsmTransitionRow | null = null;
  // Set to the event's error when an xstate.error.actor.* event selects no
  // transition (#520).
  let unhandledActorError: Json | undefined;
  if (eventType !== "initialTransition_event") {
    const candidates = ((await selectAllTransitions(
      deps,
      eventType,
      resolvedState.all_nodes,
      fsmName,
      fsmVersion.toString(),
    )) as FsmTransitionRow[] | null) ?? [];
    const enabled = await selectTransitions(
      candidates,
      resolvedState.all_nodes,
      async (guard) => {
        const guardFn = findSyncOperationHandler(
          syncOperationRegistrations,
          "guard",
          guard.type,
        );
        if (typeof guardFn !== "function") {
          // XState throws for a guard without an implementation; here the
          // transition is just not taken.
          logger.error("Guard {guard} has no implementation", {
            guard: guard.type,
          });
          return false;
        }
        // Generated guard stubs take (context, event).
        return Boolean(
          await guardFn(current_context, msgData.eventData, {
            params: guard.params ?? {},
            deps,
            queueName,
            msg,
          }),
        );
      },
    );
    if (enabled.length === 0 && eventType.startsWith("xstate.error.actor.")) {
      // XState's macrostep:
      //   if (isErrorActorEvent(currentEvent) && !transitions.length) {
      //     nextSnapshot = cloneMachineSnapshot(snapshot, { status: 'error', error: currentEvent.error });
      //   }
      // An actor's error that no transition handles stops the machine (#520).
      unhandledActorError = msgData.eventData?.eventPayload ?? null;
      logger.warn(
        "Unhandled actor error {eventType}; the instance stops in error",
        {
          eventType,
        },
      );
    } else if (enabled.length === 0) {
      // Like XState, an event no transition takes is consumed with no change:
      // microstep_v2 with no transition keeps the state.
      logger.info("No enabled transition for event {eventType}", {
        eventType,
      });
    } else {
      if (enabled.length > 1) {
        // One per parallel region; microstep_v2 takes one transition. Running
        // them together is left to a later spec (SPEC-010's non-goals).
        logger.warn(
          "{count} transitions enabled for event {eventType} (one per region); only the first runs",
          { count: enabled.length, eventType },
        );
      }
      selectedTransition = enabled[0];
      logger.info("Selected Transition: {transition}", {
        transition: selectedTransition,
      });
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
  // Exit actions, and the timers and invokes they stop: a state's own exit
  // (microstep_v2's exit_actions) and, once the machine is done, every
  // remaining state's (completion_exit_actions, #518).
  const runExitActions = async (actions: Json[]) => {
    for (const action of actions as typeof exit_actions) {
      // find actions implementations and execute fn
      // do comapre based on type or action_type
      // example  // type === xstate.raise or action_type === raise
      if (action.type === "xstate.raise") { // TODO: update action_type
        remove_schedule_queue_msg_ids_xstate.push(action);
      } else if (action.type === "xstate.cancel") {
        // An `after` timer of the state being exited: cancel its scheduled
        // event by name (`xstate.after.<key>.<state id>`), so it can't fire
        // after the state is gone (#516).
        const eventType = delayedEventType(action);
        if (eventType) {
          remove_schedule_queue_msg_ids_xstate.push({
            ...action,
            id: eventType,
          });
        }
      } else if (action.type === "xstate.invoke") { //
        // this is equivalent to xstate.stopChild from worker-helper.ts
        remove_async_operation_queue_msg_ids_xstate.push(action);
      } else {
        // fsm events - try to execute implementation from actionsModule
        current_context = await runActionImplementation(
          "exit",
          action,
          syncOperationRegistrations,
          current_context,
          { deps, queueName, msg },
        );
      }
    }
  };
  await runExitActions(exit_actions);
  const transition_actions = microstepResult.transition_actions || [];
  for (const action of transition_actions) {
    // find actions implementations and execute fn
    // action_type === invoke or type === xstate.invoke
    current_context = await runActionImplementation(
      "transition",
      action,
      syncOperationRegistrations,
      current_context,
      { deps, queueName, msg },
    );
  }

  // Entry, invoke and initial actions in XState's order: microstep_v2 returns
  // the initial actions separately (#506).
  const entry_actions = orderEntryActions(
    microstepResult.entry_actions,
    microstepResult.initial_actions,
  );
  for (const action of entry_actions) {
    // find actions implementations and execute fn
    // do comapre based on type or  action_type
    // example  // type === xstate.raise or action_type === raise
    if (action.type === "xstate.raise") { //
      // An `after` transition's delayed raise (the compiler's
      // delayActionName / delayActionEventType, #516). A raise you write
      // yourself isn't in fsm.json: XState serializes it without its event.
      const eventType = delayedEventType(action);
      if (!eventType) {
        logger.error(
          "xstate.raise without an event can't be sent: {action}",
          { action },
        );
        continue;
      }
      const delay = await resolveRaiseDelay(action, async (name) => {
        const delayFn = findSyncOperationHandler(
          syncOperationRegistrations,
          "delay",
          name,
        );
        if (typeof delayFn !== "function") {
          logger.error("Delay {delay} has no implementation", {
            delay: name,
          });
          return undefined;
        }
        // Generated delay stubs take (context, event) and return ms.
        return await delayFn(current_context, msgData.eventData);
      });
      if (delay === undefined) {
        // XState raises it without a delay when the delay doesn't resolve to
        // a number; until the internal queue (SPEC-010) it's sent now.
        logger.warn(
          "Delay for {eventType} did not resolve to milliseconds; sending it now",
          { eventType },
        );
      }
      // update macroSaveFnPayload for new schedule queue data: the archive
      // sends `id` (the event name) to this instance's queue after `delay` ms.
      new_schedule_queue_data.push({
        ...action,
        "type": action.type,
        "id": eventType,
        "delay": delay ?? 0,
        "input": { type: eventType },
        "fsmType": action.parentFsmName,
        "fsmVersion": action.parentFsmVersion,
      });
    } else if (action.type === "xstate.invoke") {
      // this is equivalent to xstate.spawnChild from worker-helper.ts. Its
      // input (SPEC-013) is computed now, from the context after this step's
      // transition and entry actions and the event that entered the state,
      // and queued with it.
      const invoke = await invokeWithInput(
        action as Record<string, unknown>,
        async (name) => {
          const inputFn = findSyncOperationHandler(
            syncOperationRegistrations,
            "input",
            name,
          );
          if (typeof inputFn !== "function") return { found: false };
          // Generated input stubs take (context, event).
          return {
            found: true,
            value: await inputFn(current_context, msgData.eventData),
          };
        },
        (problem) =>
          logger.error(
            "Input {inputName} of invoke {invokeId} ({reason}): the actor gets null. {error}",
            {
              inputName: problem.inputName,
              invokeId: (action as { id?: unknown }).id,
              reason: problem.reason,
              error: problem.error,
            },
          ),
      );
      new_async_operation_queue_data.push({ ...invoke, "type": action.type });
    } else {
      // fsm events - try to execute implementation from actionsModule
      current_context = await runActionImplementation(
        action.action_type === "initial" ? "initial" : "entry",
        action,
        syncOperationRegistrations,
        current_context,
        { deps, queueName, msg },
      );
    }
  }

  // Done (a top-level final state): XState then runs every remaining state's
  // exit actions, deepest first, and stops the machine's children (#518).
  const done = (microstepResult as { done?: unknown }).done === true;
  if (done) {
    await runExitActions(
      (microstepResult.completion_exit_actions ?? []) as typeof exit_actions,
    );
  }

  // remove msg.message?.type from remove_schedule_queue_msg_ids_xstate because msg.message?.type will be removed from current queue it self in step 6 of save micro fn
  remove_schedule_queue_msg_ids_xstate = remove_schedule_queue_msg_ids_xstate
    .filter((item) =>
      item !==
        (msg.message as unknown as FsmQueueMessage)?.eventData?.eventPayload
    );

  // get both removed and new_total_schedule_queue_data
  // const [new_total_schedule_queue_data, remove_schedule_queue_msg_ids] = splitByEventTypes(total_schedule_queue_data, remove_schedule_queue_msg_ids_xstate);

  // macroSaveFnPayload.to_be_removed_schedule_queue_msg_ids = remove_schedule_queue_msg_ids;
  // macroSaveFnPayload.input_total_schedule_queue_data = new_total_schedule_queue_data;
  // macroSaveFnPayload.to_be_added_schedule_queue_data = new_schedule_queue_data;

  macroSaveFnPayload.to_be_removed_schedule_queue_msg_ids =
    remove_schedule_queue_msg_ids_xstate;
  macroSaveFnPayload.to_be_added_schedule_queue_data = new_schedule_queue_data;
  macroSaveFnPayload.input_total_schedule_queue_data =
    total_schedule_queue_data;

  // cancle ivnoke of previous state's children ( PATCH )
  // const [new_total_async_operation_queue_data, remove_async_operation_queue_msg_ids] =  splitBySendEventName(total_async_operation_queue_data, remove_async_operation_queue_msg_ids_xstate);

  // // remove current async-operation event from total_async_operation_queue_data if it is executing xstate.done.actor or xstate.error.actor events
  // let removeEventName;
  // removeEventName = eventType.replace("xstate.done.actor.", "");
  // removeEventName = removeEventName.replace("xstate.error.actor.", "");
  // const update_new_total_async_operation_queue_data = new_total_async_operation_queue_data.filter((item)=> item.event.send_event_name_to_parent_queue_id !== removeEventName);

  // macroSaveFnPayload.to_be_removed_async_operation_queue_msg_ids = remove_async_operation_queue_msg_ids;
  // macroSaveFnPayload.input_total_async_operation_queue_data = update_new_total_async_operation_queue_data;
  // macroSaveFnPayload.to_be_added_async_operation_queue_data = new_async_operation_queue_data;

  macroSaveFnPayload.to_be_removed_async_operation_queue_msg_ids =
    remove_async_operation_queue_msg_ids_xstate;
  macroSaveFnPayload.to_be_added_async_operation_queue_data =
    new_async_operation_queue_data;
  macroSaveFnPayload.input_total_async_operation_queue_data =
    total_async_operation_queue_data;

  macroSaveFnPayload.fsm_instance_data_save_fsm_context = current_context;

  // microstepResult.updated_state_value is keyed by the machine's root
  // (its id, `machine` by default); the saved state value is XState's, without
  // it (#499).
  macroSaveFnPayload.fsm_instance_data_save_fsm_state = stateValueWithoutRoot(
    microstepResult.updated_state_value,
  );

  // Done once the machine is in a top-level final state (microstep_v2 from
  // fsm_core 2.1.2 reports it; an older database never does), read above.
  macroSaveFnPayload.fsm_instance_data_save_fsm_status = done
    ? "done"
    : unhandledActorError !== undefined
    ? "error"
    : "active"; // "active" | "done" | "error" | "stopped"
  // The error saved with status error; null keeps the instance's error.
  macroSaveFnPayload.fsm_instance_data_save_fsm_error =
    unhandledActorError === undefined ? null : unhandledActorError;
  macroSaveFnPayload.fsm_instance_data_save_fsm_output = {};

  macroSaveFnPayload.fsm_instance_data_save_fsm_xstate_state =
    microstepResult?.updated_state_value ?? null;

  // The done.state events this microstep raised go to the archive unchanged,
  // which puts them on the instance's internal event queue (SPEC-010, #519).
  macroSaveFnPayload.raised_events = (microstepResult.raised_events ??
    []) as Json[];

  macroSaveFnPayload.exit_actions = exit_actions;
  macroSaveFnPayload.transition_actions = transition_actions;
  macroSaveFnPayload.entry_actions = entry_actions;

  return macroSaveFnPayload;
}
