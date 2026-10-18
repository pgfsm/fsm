import { assertEquals } from "@std/assert";
import {
  delayedEventType,
  delayKey,
  resolveRaiseDelay,
} from "../src/fsmlet/delays.ts";

const raise = (key: string, eventType = `xstate.after.${key}.m.a`) => ({
  type: "xstate.raise",
  delayActionName: `delay${key}`,
  delayActionEventType: eventType,
});
/** Answers named delays from `delays`, and records which it was asked for. */
const delays = (values: Record<string, unknown>) => {
  const asked: string[] = [];
  const evaluate = (name: string) => {
    asked.push(name);
    return Promise.resolve(values[name]);
  };
  return { asked, evaluate };
};

Deno.test("resolveRaiseDelay: a numeric after key is the delay in ms, with no implementation called (#516)", async () => {
  const d = delays({});
  assertEquals(await resolveRaiseDelay(raise("1000"), d.evaluate), 1000);
  assertEquals(d.asked, []);
});

Deno.test("resolveRaiseDelay: a named after key uses the registered delay's result", async () => {
  const d = delays({ short1000delay: 1000 });
  assertEquals(
    await resolveRaiseDelay(raise("short1000delay"), d.evaluate),
    1000,
  );
  assertEquals(d.asked, ["short1000delay"]);
});

Deno.test("resolveRaiseDelay: a named delay that doesn't give milliseconds means no delay, as in XState", async () => {
  for (const value of [undefined, "soon", -5, Number.NaN]) {
    assertEquals(
      await resolveRaiseDelay(
        raise("vc1000delay"),
        delays({ vc1000delay: value }).evaluate,
      ),
      undefined,
    );
  }
});

Deno.test("resolveRaiseDelay: a raise without the compiler's delay fields has no delay", async () => {
  assertEquals(
    await resolveRaiseDelay({ type: "xstate.raise" }, delays({}).evaluate),
    undefined,
  );
});

Deno.test("delayKey / delayedEventType read the compiler's fields", () => {
  const action = raise(
    "1000",
    "xstate.after.1000.checkcarvitals.CheckContinueVitalChecks",
  );
  assertEquals(delayKey(action), "1000");
  assertEquals(
    delayedEventType(action),
    "xstate.after.1000.checkcarvitals.CheckContinueVitalChecks",
  );
  assertEquals(delayKey({ type: "xstate.raise" }), undefined);
  assertEquals(delayedEventType({ type: "xstate.raise" }), undefined);
});
