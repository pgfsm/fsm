import { assertEquals } from "@std/assert";
import { stateValueWithoutRoot } from "../src/fsmlet/state-value.ts";

Deno.test("stateValueWithoutRoot strips the default `machine` root", () => {
  assertEquals(
    stateValueWithoutRoot({
      machine: { creditCheck: "Verifying_Credentials" },
    }),
    { creditCheck: "Verifying_Credentials" },
  );
});

Deno.test("stateValueWithoutRoot strips a machine's own id as the root (#499)", () => {
  assertEquals(
    stateValueWithoutRoot({
      loadTest: { Working: { TypeScript: "Done", Python: "Running" } },
    }),
    { Working: { TypeScript: "Done", Python: "Running" } },
  );
  assertEquals(stateValueWithoutRoot({ loadTest: "Finished" }), "Finished");
});

Deno.test("stateValueWithoutRoot leaves values without a single root alone", () => {
  assertEquals(stateValueWithoutRoot(null), null);
  assertEquals(stateValueWithoutRoot("Idle"), "Idle");
  assertEquals(stateValueWithoutRoot({ a: "x", b: "y" }), { a: "x", b: "y" });
});
