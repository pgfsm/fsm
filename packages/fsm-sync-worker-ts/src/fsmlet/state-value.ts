import type { Json } from "@pgfsm/db/database.types";

/**
 * microstep_v2's `updated_state_value` is keyed by the machine's root state
 * node (`{ "<root>": { ... } }`), while an XState state value, which is what
 * `fsm_instance.fsm_instance_state` holds and `resolve_state_value_v2` reads
 * back, has no root key. The root is the machine's `id`: `machine` for one
 * without (XState's default `(machine)`), e.g. `loadTest` for
 * `createMachine({ id: "loadTest" })`. Reading a fixed `machine` key lost the
 * state of every FSM with an explicit id (#499).
 */
export function stateValueWithoutRoot(updatedStateValue: Json): Json {
  if (
    updatedStateValue === null || typeof updatedStateValue !== "object" ||
    Array.isArray(updatedStateValue)
  ) {
    return updatedStateValue;
  }
  const roots = Object.keys(updatedStateValue);
  return roots.length === 1
    ? (updatedStateValue[roots[0]] ?? null)
    : updatedStateValue;
}
