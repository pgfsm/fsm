import type { Json } from "@pgfsm/db/database.types";

/**
 * The compiler writes an `after` transition's delayed raise (and its cancel)
 * with the delay key behind this prefix: `after: { 1000: … }` becomes
 * `delayActionName: "delay1000"`, `after: { short: … }` `"delayshort"`
 * (`DELAY_ACTION_NAME_PREFIX` in fsm-compiler-ts).
 */
const DELAY_ACTION_NAME_PREFIX = "delay";

/** Runs a named delay's implementation; its milliseconds, or anything else. */
export type DelayEvaluator = (name: string) => Promise<unknown>;

/**
 * XState's delay resolution for a raise (`resolveRaise` in
 * packages/core/src/actions/raise.ts, #516): a numeric `after` key is the
 * delay in milliseconds; a named key is looked up in the machine's delays,
 * here the registered `delay` sync operation of that name, and called. When
 * that gives no number the event is raised without a delay, so `undefined`
 * is returned and the caller raises it now.
 */
export async function resolveRaiseDelay(
  action: Json,
  evaluateDelay: DelayEvaluator,
): Promise<number | undefined> {
  const key = delayKey(action);
  if (key === undefined) return undefined;
  if (/^\d+(\.\d+)?$/.test(key)) return Number(key);
  const delay = await evaluateDelay(key);
  return typeof delay === "number" && Number.isFinite(delay) && delay >= 0
    ? delay
    : undefined;
}

/** The `after` key of a compiled raise or cancel (`delayActionName` minus its prefix). */
export function delayKey(action: Json): string | undefined {
  const name = field(action, "delayActionName");
  return typeof name === "string" && name.startsWith(DELAY_ACTION_NAME_PREFIX)
    ? name.slice(DELAY_ACTION_NAME_PREFIX.length)
    : undefined;
}

/** The event a compiled raise sends, or a cancel cancels (`xstate.after.<key>.<state id>`). */
export function delayedEventType(action: Json): string | undefined {
  const eventType = field(action, "delayActionEventType");
  return typeof eventType === "string" && eventType !== ""
    ? eventType
    : undefined;
}

function field(action: Json, name: string): Json | undefined {
  return action !== null && typeof action === "object" && !Array.isArray(action)
    ? action[name]
    : undefined;
}
