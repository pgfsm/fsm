import type { Json } from "@pgfsm/db/database.types";

/** The fields of a stored transition (fsm_core.fsm_transitions) selection reads. */
export type TransitionCandidate = {
  id: number;
  computed_sanitized_source_ltree: unknown;
  cond: Json;
};

/** A guard as stored: a named guard, with its params when it has any. */
export type GuardRef = { type: string; params?: Json };

/** Runs a guard's implementation; false when it doesn't pass. */
export type GuardEvaluator = (guard: GuardRef) => Promise<boolean>;

/**
 * XState's transition selection (`transitionNode`, `StateNode.next` and
 * `getCandidates` in packages/core/src/stateUtils.ts and StateNode.ts) over
 * the event's candidate transitions (#510):
 *
 * - From each active leaf, deepest first: a state's own transitions win, and
 *   only when none of them is enabled does its parent get a turn (an atomic or
 *   compound state bubbles up; a parallel state only when none of its regions
 *   selected anything).
 * - Per state, the first candidate in definition order whose guard passes.
 * - At most one per parallel region, so several can come back.
 *
 * `candidates` are the event's transitions whose source is active (from
 * select_all_transitions_v2), `activeNodes` the full active configuration
 * (key paths, ancestors included). Wildcard event descriptors and history are
 * not supported.
 */
export async function selectTransitions<T extends TransitionCandidate>(
  candidates: readonly T[],
  activeNodes: readonly string[],
  evaluateGuard: GuardEvaluator,
): Promise<T[]> {
  const nodes = [...new Set(activeNodes)];
  // A state's parent is its nearest active ancestor. Prefixes are compared on
  // whole labels, so a root id with dots ("com.acme.m") is one state.
  const parentOf = (node: string): string | undefined =>
    nodes
      .filter((other) => node.startsWith(`${other}.`))
      .sort((a, b) => b.length - a.length)[0];
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const node of nodes) {
    const parent = parentOf(node);
    if (parent === undefined) roots.push(node);
    else childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), node]);
  }

  // getCandidates: a state's transitions for this event, in definition order
  // (the loader inserts them in document order, so by id).
  const bySource = new Map<string, T[]>();
  for (const candidate of [...candidates].sort((a, b) => a.id - b.id)) {
    const source = String(candidate.computed_sanitized_source_ltree);
    bySource.set(source, [...(bySource.get(source) ?? []), candidate]);
  }

  // StateNode.next: the first candidate whose guard passes.
  const next = async (node: string): Promise<T[]> => {
    for (const candidate of bySource.get(node) ?? []) {
      if (await guardPasses(candidate.cond, evaluateGuard)) return [candidate];
    }
    return [];
  };

  // transitionNode: an atomic state is a leaf; a compound state has one active
  // child and a parallel state one per region, so both collect what their
  // children select and fall back to their own transitions.
  const select = async (node: string): Promise<T[]> => {
    const children = (childrenOf.get(node) ?? []).sort();
    const inner: T[] = [];
    for (const child of children) inner.push(...await select(child));
    return inner.length ? inner : await next(node);
  };

  const selected: T[] = [];
  for (const root of roots.sort()) selected.push(...await select(root));
  return selected;
}

/**
 * A stored guard (`cond`, from the transition's `guard` in fsm.json): none
 * passes; a name or `{ type, params }` runs that guard; a JSON boolean is
 * itself. Anything else does not pass.
 */
async function guardPasses(
  cond: Json,
  evaluateGuard: GuardEvaluator,
): Promise<boolean> {
  if (cond === null || cond === undefined) return true;
  if (typeof cond === "boolean") return cond;
  if (typeof cond === "string") return await evaluateGuard({ type: cond });
  if (
    typeof cond === "object" && !Array.isArray(cond) &&
    typeof cond.type === "string"
  ) {
    return await evaluateGuard({ type: cond.type, params: cond.params });
  }
  return false;
}
