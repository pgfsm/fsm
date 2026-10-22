import { assertEquals } from "@std/assert";
import {
  type InputProblem,
  invokeWithInput,
} from "../src/fsmlet/invoke-input.ts";

const invoke = (fields: Record<string, unknown> = {}) => ({
  type: "xstate.invoke",
  id: "bureauActor",
  src: "checkBureau",
  ...fields,
});

/** Answers input stubs from `stubs`, and records what was asked and reported. */
function harness(stubs: Record<string, () => unknown>) {
  const asked: string[] = [];
  const problems: InputProblem[] = [];
  const evaluate = async (name: string) => {
    asked.push(name);
    const stub = stubs[name];
    return stub ? { found: true as const, value: await stub() } : {
      found: false as const,
    };
  };
  return {
    asked,
    problems,
    evaluate,
    report: (p: InputProblem) => problems.push(p),
  };
}

Deno.test("invokeWithInput: a static input is queued as is, with no stub called (SPEC-013)", async () => {
  const h = harness({});
  const out = await invokeWithInput(
    invoke({ input: { bureauName: "EquiGavin" } }),
    h.evaluate,
    h.report,
  );
  assertEquals(out.input, { bureauName: "EquiGavin" });
  assertEquals(h.asked, []);
  assertEquals(h.problems, []);
});

Deno.test("invokeWithInput: an invoke without input is unchanged", async () => {
  const h = harness({});
  const original = invoke();
  assertEquals(await invokeWithInput(original, h.evaluate, h.report), original);
  assertEquals(h.asked, []);
});

Deno.test("invokeWithInput: an inputName is computed by its stub and stored as input", async () => {
  const h = harness({
    bureauActor: () => ({ ssn: "123", bureauName: "EquiGavin" }),
  });
  const out = await invokeWithInput(
    invoke({ inputName: "bureauActor" }),
    h.evaluate,
    h.report,
  );
  assertEquals(out.input, { ssn: "123", bureauName: "EquiGavin" });
  assertEquals(out.inputName, "bureauActor");
  assertEquals(h.asked, ["bureauActor"]);
  assertEquals(h.problems, []);
});

Deno.test("invokeWithInput: an async stub is awaited; a string result is a value", async () => {
  const h = harness({ s: () => Promise.resolve("EquiGavin") });
  const out = await invokeWithInput(
    invoke({ inputName: "s" }),
    h.evaluate,
    h.report,
  );
  assertEquals(out.input, "EquiGavin");
});

Deno.test("invokeWithInput: a missing stub, a throw, or a non-JSON result gives null and reports why", async () => {
  const h = harness({
    throws: () => {
      throw new Error("boom");
    },
    date: () => ({ at: new Date() }),
  });
  for (const name of ["missing", "throws", "date"]) {
    const out = await invokeWithInput(
      invoke({ inputName: name }),
      h.evaluate,
      h.report,
    );
    assertEquals(out.input, null, name);
  }
  assertEquals(
    h.problems.map((p) => [p.inputName, p.reason]),
    [["missing", "missing"], ["throws", "threw"], ["date", "not_json"]],
  );
  assertEquals((h.problems[1].error as Error).message, "boom");
});

Deno.test("invokeWithInput: a stub returning nothing gives null without a problem", async () => {
  const h = harness({ nothing: () => undefined });
  const out = await invokeWithInput(
    invoke({ inputName: "nothing" }),
    h.evaluate,
    h.report,
  );
  assertEquals(out.input, null);
  assertEquals(h.problems, []);
});

Deno.test("invokeWithInput: the stored input is a copy, not the stub's object", async () => {
  const shared = { n: 1 };
  const h = harness({ s: () => shared });
  const out = await invokeWithInput(
    invoke({ inputName: "s" }),
    h.evaluate,
    h.report,
  );
  shared.n = 2;
  assertEquals(out.input, { n: 1 });
});
