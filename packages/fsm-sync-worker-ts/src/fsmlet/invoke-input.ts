import type { Json } from "@pgfsm/db/database.types";

/**
 * Runs a named input sync operation (SPEC-013, #586): the registered `input`
 * stub of that name called with `(context, event)`, or `undefined` when there
 * is no such stub.
 */
export type InputEvaluator = (
  name: string,
) => Promise<{ found: false } | { found: true; value: unknown }>;

/** Why an input couldn't be computed; the actor then gets `null`. */
export type InputProblem = {
  inputName: string;
  reason: "missing" | "not_json";
};

/** True for a value JSON round-trips unchanged. */
function isJsonValue(value: unknown): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object": {
      if (Array.isArray(value)) return value.every(isJsonValue);
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return false;
      return Object.values(value as Record<string, unknown>).every(
        isJsonValue,
      );
    }
    default:
      return false;
  }
}

/**
 * An invoke as it's queued for its actor or child FSM, with its input
 * (SPEC-013). A static `input` from fsm.json is kept as is. An `inputName` is
 * computed now, when the invoke starts, by its input stub, and the result is
 * stored as the invoke's `input`, so redelivery reuses it. A stub that's
 * missing or returns something that isn't JSON gives `null`, and `onProblem`
 * is told why. A stub that returns nothing (`undefined`) gives `null` too,
 * without a problem. A stub that throws fails the step: the error propagates,
 * and the worker retries the step, then sets status error (SPEC-014).
 */
export async function invokeWithInput(
  invoke: Record<string, unknown>,
  evaluateInput: InputEvaluator,
  onProblem: (problem: InputProblem) => void,
): Promise<Record<string, unknown>> {
  const inputName = invoke.inputName;
  if (typeof inputName !== "string") return invoke;

  let input: Json = null;
  const result = await evaluateInput(inputName);
  if (!result.found) {
    onProblem({ inputName, reason: "missing" });
  } else if (result.value === undefined) {
    input = null;
  } else if (!isJsonValue(result.value)) {
    onProblem({ inputName, reason: "not_json" });
  } else {
    input = JSON.parse(JSON.stringify(result.value));
  }
  return { ...invoke, input };
}
