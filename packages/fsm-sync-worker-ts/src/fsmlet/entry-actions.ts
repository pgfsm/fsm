import type { Json } from "@pgfsm/db/database.types";

/**
 * Puts microstep_v2's `entry_actions` (entry and invoke actions of the states
 * entered) and `initial_actions` (the `initial.actions` of states entered by
 * default) into the order XState's `enterStates` runs them: states parents
 * first, and for each state its entry and invoke actions, then its initial
 * actions (#506).
 *
 * Both lists tag each action with its state's `fsm_order` (document order, so
 * a parent's is lower than its children's). Within one state, actions keep the
 * order microstep_v2 returned them in. Sorting here also fixes the order from
 * databases before fsm_core 2.1.3, which return children first.
 */
export function orderEntryActions(
  entryActions: Json,
  initialActions: Json,
): Json[] {
  const tagged = [
    ...asArray(entryActions).map((action, index) => ({
      action,
      phase: 0,
      index,
    })),
    ...asArray(initialActions).map((action, index) => ({
      action,
      phase: 1,
      index,
    })),
  ];
  tagged.sort((a, b) =>
    stateOrder(a.action) - stateOrder(b.action) || a.phase - b.phase ||
    a.index - b.index
  );
  return tagged.map(({ action }) => action);
}

function asArray(actions: Json): Json[] {
  return Array.isArray(actions) ? actions : [];
}

/** An action without a numeric `fsm_order` sorts after the tagged ones. */
function stateOrder(action: Json): number {
  const order = action !== null && typeof action === "object" &&
      !Array.isArray(action)
    ? action.fsm_order
    : undefined;
  return typeof order === "number" ? order : Number.MAX_SAFE_INTEGER;
}
