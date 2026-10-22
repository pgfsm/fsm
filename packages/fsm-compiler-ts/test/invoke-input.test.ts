// SPEC-013 (#585): the compiler writes each invoke's input into fsm.json (a
// literal `input`, or an `inputName` for an input function), a static root
// context, and the compile-time input-mappers.json; generate-sync-logic then
// writes a TypeScript input stub per inputName, pre-filled from that source,
// registered as sync-operation type `input`.

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  addInvokeInputs,
  generateFsmJSONFromMachineFile,
  INPUT_MAPPERS_FILE_NAME,
  readInputMappers,
} from "../src/generate-fsm-json.ts";
import { generateSyncOperationLogicFromFolders } from "../src/generate-sync-operation-logic.ts";
import type { FsmDraftStateNode } from "../src/types/index.ts";
import { makeWorkspaceTempDir } from "./test-helpers.ts";

/** The fsm.json shape of a state with these invokes (as toJSON + defaults give). */
function jsonState(srcs: string[], type = "internalAsyncOperation") {
  return {
    invoke: srcs.map((src, i) => ({
      type: "xstate.invoke",
      id: `${i}.(machine).x`,
      src,
      asyncOperationType: type,
      asyncOperationVersion: "v01",
    })),
  } as FsmDraftStateNode;
}

Deno.test("addInvokeInputs - a static value is written as a literal input, a string included", () => {
  const { fulljson, inputMappers } = addInvokeInputs(
    { states: { a: jsonState(["one", "two", "three"]) } },
    {
      states: {
        a: {
          invoke: [
            { src: "one", input: { bureauName: "EquiGavin" } },
            { src: "two", input: "EquiGavin" },
            { src: "three", input: [1, 2, null] },
          ],
        },
      },
    },
  );
  const invokes = fulljson.states!.a.invoke!;
  assertEquals(invokes[0].input, { bureauName: "EquiGavin" });
  assertEquals(invokes[1].input, "EquiGavin");
  assertEquals(invokes[2].input, [1, 2, null]);
  assertEquals(invokes.map((i) => i.inputName), [
    undefined,
    undefined,
    undefined,
  ]);
  assertEquals(inputMappers, {});
});

Deno.test("addInvokeInputs - an input function becomes inputName (its id), with its source", () => {
  const mapper = ({ context }: { context: { SSN: string } }) => ({
    ssn: context.SSN,
  });
  const { fulljson, inputMappers } = addInvokeInputs(
    { states: { a: jsonState(["checkReportsTable"]) } },
    {
      states: {
        a: {
          invoke: {
            id: "equiGavinDBActor",
            src: "checkReportsTable",
            input: mapper,
          },
        },
      },
    },
  );
  const invoke = fulljson.states!.a.invoke![0];
  assertEquals(invoke.inputName, "equiGavinDBActor");
  assertEquals("input" in invoke, false);
  assertEquals(inputMappers, { equiGavinDBActor: mapper.toString() });
});

Deno.test("addInvokeInputs - rule 1: without an id, <state path>_<src>, numbered for a repeated src", () => {
  const fn = () => ({});
  const { fulljson } = addInvokeInputs(
    {
      states: {
        CheckingEquiGavin: {
          states: {
            CheckingForExistingReport: jsonState([
              "checkReportsTable",
              "checkReportsTable",
            ]),
          },
        },
      },
    },
    {
      states: {
        CheckingEquiGavin: {
          states: {
            CheckingForExistingReport: {
              invoke: [
                { src: "checkReportsTable", input: fn },
                { src: "checkReportsTable", input: fn },
              ],
            },
          },
        },
      },
    },
  );
  const invokes = fulljson.states!.CheckingEquiGavin.states!
    .CheckingForExistingReport.invoke!;
  assertEquals(
    invokes.map((i) => i.inputName),
    [
      "CheckingEquiGavin_CheckingForExistingReport_checkReportsTable",
      "CheckingEquiGavin_CheckingForExistingReport_checkReportsTable_2",
    ],
  );
});

Deno.test("addInvokeInputs - rule 1 cleans names into identifiers (spaces, digit-first)", () => {
  const fn = () => ({});
  const { fulljson } = addInvokeInputs(
    {
      states: {
        "Verifying Credentials": jsonState(["verifyCredentials"]),
        b: jsonState(["x"]),
      },
    },
    {
      states: {
        "Verifying Credentials": {
          invoke: { src: "verifyCredentials", input: fn },
        },
        b: { invoke: { id: "1st-actor", src: "x", input: fn } },
      },
    },
  );
  assertEquals(
    fulljson.states!["Verifying Credentials"].invoke![0].inputName,
    "Verifying_Credentials_verifyCredentials",
  );
  assertEquals(fulljson.states!.b.invoke![0].inputName, "input_1st_actor");
});

Deno.test("addInvokeInputs - names that collide, ignoring case, fail the compile", () => {
  const fn = () => ({});
  assertThrows(
    () =>
      addInvokeInputs(
        { states: { a: jsonState(["x"]), b: jsonState(["y"]) } },
        {
          states: {
            a: { invoke: { id: "fetch", src: "x", input: fn } },
            b: { invoke: { id: "Fetch", src: "y", input: fn } },
          },
        },
      ),
    Error,
    "collides with",
  );
});

Deno.test("addInvokeInputs - a static input that isn't JSON fails the compile", () => {
  assertThrows(
    () =>
      addInvokeInputs(
        { states: { a: jsonState(["x"]) } },
        { states: { a: { invoke: { src: "x", input: { at: new Date() } } } } },
      ),
    Error,
    "isn't JSON",
  );
  assertThrows(
    () =>
      addInvokeInputs(
        { states: { a: jsonState(["x"]) } },
        { states: { a: { invoke: { src: "x", input: { gone: undefined } } } } },
      ),
    Error,
    "isn't JSON",
  );
});

Deno.test("addInvokeInputs - a child FSM's static input must be an object", () => {
  assertThrows(
    () =>
      addInvokeInputs(
        { states: { a: jsonState(["childFsm"], "fsm") } },
        { states: { a: { invoke: { src: "childFsm", input: "nope" } } } },
      ),
    Error,
    "must be an object",
  );
  const { fulljson } = addInvokeInputs(
    { states: { a: jsonState(["childFsm"], "fsm") } },
    { states: { a: { invoke: { src: "childFsm", input: { ssn: "1" } } } } },
  );
  assertEquals(fulljson.states!.a.invoke![0].input, { ssn: "1" });
});

Deno.test("addInvokeInputs - a static context is written; a context function is not", () => {
  assertEquals(
    addInvokeInputs({ states: {} }, { context: { tries: 0 }, states: {} })
      .fulljson.context,
    { tries: 0 },
  );
  assertEquals(
    "context" in
      addInvokeInputs({ states: {} }, {
        context: () => ({ tries: 0 }),
        states: {},
      }).fulljson,
    false,
  );
  assertEquals(
    addInvokeInputs({ states: {} }, {
      context: { tasks: [], error: undefined, nested: { gone: undefined } },
      states: {},
    }).fulljson.context,
    { tasks: [], nested: {} },
  );
  assertThrows(
    () =>
      addInvokeInputs({ states: {} }, {
        context: { at: new Date() },
        states: {},
      }),
    Error,
    "static context must be a JSON object",
  );
  assertThrows(
    () => addInvokeInputs({ states: {} }, { context: [1], states: {} }),
    Error,
    "static context must be a JSON object",
  );
});

Deno.test("addInvokeInputs - an FSM with no input or context is unchanged", () => {
  const fsmJSON: FsmDraftStateNode = {
    id: "m",
    states: { a: jsonState(["x"]), b: { states: { c: jsonState(["y"]) } } },
  };
  const { fulljson, inputMappers } = addInvokeInputs(fsmJSON, {
    id: "m",
    states: {
      a: { invoke: { src: "x" } },
      b: { states: { c: { invoke: [{ src: "y" }] } } },
    },
  });
  assertEquals(JSON.stringify(fulljson), JSON.stringify(fsmJSON));
  assertEquals(inputMappers, {});
});

Deno.test({
  name:
    "machine.ts → fsm.json, input-mappers.json, a pre-filled input stub and an input registration (#585)",
  sanitizeResources: false,
  fn: async () => {
    const root = await makeWorkspaceTempDir("invoke-input");
    try {
      const dir = `${root}/fsm/spec013/v01`;
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(
        `${dir}/machine.ts`,
        `import { createMachine } from "xstate";
export default createMachine({
  id: "spec013",
  context: { SSN: "", tries: 0 },
  initial: "checking",
  states: {
    checking: {
      invoke: {
        id: "bureauActor",
        src: "checkBureau",
        input: ({ context }: any) => ({ bureauName: "EquiGavin", ssn: context.SSN }),
      },
    },
    waiting: {
      invoke: { src: "checkReportsTable", input: { bureauName: "GavUnion" } },
    },
  },
});
`,
      );
      await generateFsmJSONFromMachineFile(dir, "v01");

      const fsmJson = JSON.parse(await Deno.readTextFile(`${dir}/fsm.json`));
      assertEquals(fsmJson.context, { SSN: "", tries: 0 });
      assertEquals(fsmJson.states.checking.invoke[0].inputName, "bureauActor");
      assertEquals(fsmJson.states.waiting.invoke[0].input, {
        bureauName: "GavUnion",
      });
      const mappers = await readInputMappers(dir);
      assertStringIncludes(mappers.bureauActor, "EquiGavin");
      // No code in the definition itself.
      assertEquals(
        JSON.stringify(fsmJson).includes("EquiGavin") &&
          JSON.stringify(fsmJson).includes("=>"),
        false,
      );

      await generateSyncOperationLogicFromFolders(
        `${root}/fsm`,
        ["typescript"],
        [],
        root,
      );
      const tsRoot = `${root}/sync-worker/typescript/spec013/v01`;
      const stub = await Deno.readTextFile(
        `${tsRoot}/inputs/bureauActor/bureauActor.ts`,
      );
      assertStringIncludes(stub, "export function bureauActor(");
      assertStringIncludes(stub, "EquiGavin");
      assertStringIncludes(stub, "Copied from machine.ts");
      const registry = await Deno.readTextFile(
        `${tsRoot}/sync-operation-registry.generated.ts`,
      );
      assertStringIncludes(registry, `syncOperationType: "input"`);
      assertStringIncludes(registry, `syncOperationName: "bureauActor"`);

      // The pre-filled stub type-checks as written.
      const check = await new Deno.Command(Deno.execPath(), {
        args: ["check", `${tsRoot}/inputs/bureauActor/bureauActor.ts`],
        stdout: "null",
        stderr: "piped",
      }).output();
      assert(
        check.success,
        new TextDecoder().decode(check.stderr),
      );

      // A machine without input functions leaves no stale input-mappers.json
      // (a fresh folder: Deno caches an imported machine.ts by its URL).
      const dir2 = `${root}/fsm/spec013/v02`;
      await Deno.mkdir(dir2, { recursive: true });
      await Deno.writeTextFile(`${dir2}/${INPUT_MAPPERS_FILE_NAME}`, "{}");
      await Deno.writeTextFile(
        `${dir2}/machine.ts`,
        `import { createMachine } from "xstate";
export default createMachine({ id: "spec013", initial: "a", states: { a: {} } });
`,
      );
      await generateFsmJSONFromMachineFile(dir2, "v02");
      assertEquals(await readInputMappers(dir2), {});
      await Deno.stat(`${dir2}/${INPUT_MAPPERS_FILE_NAME}`).then(
        () => {
          throw new Error("input-mappers.json should be gone");
        },
        () => undefined,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
