import { assertEquals, assertExists } from "@std/assert";
import { addMissingFsmTypeToInvokeActor, generateFsmJSONFromFolders, normalizeActionsToObjects } from "../src/generateFsmJSON.ts";

// --- addMissingFsmTypeToInvokeActor unit tests ---

Deno.test("addMissingFsmTypeToInvokeActor - adds missing fsmType and fsmVersion", () => {
  const fsmJSON = {
    states: {
      idle: {
        invoke: [{ src: "someActor" }],
      },
    },
  };
  const { fulljson, childActorsInfo } = addMissingFsmTypeToInvokeActor(fsmJSON, "v01");

  assertEquals(fulljson.states.idle.invoke[0].fsmType, "promise");
  assertEquals(fulljson.states.idle.invoke[0].fsmVersion, "v01");
  assertEquals(childActorsInfo.length, 1);
  assertEquals(childActorsInfo[0].child_actor_src, "someActor");
  assertEquals(childActorsInfo[0].child_actor_fsmType, "promise");
  assertEquals(childActorsInfo[0].child_actor_fsmVersion, "v01");
});

Deno.test("addMissingFsmTypeToInvokeActor - preserves existing fsmType and fsmVersion", () => {
  const fsmJSON = {
    states: {
      idle: {
        invoke: [{ src: "sharedActor", fsmType: "sharedFsm", fsmVersion: "v02" }],
      },
    },
  };
  const { fulljson, childActorsInfo } = addMissingFsmTypeToInvokeActor(fsmJSON, "v01");

  assertEquals(fulljson.states.idle.invoke[0].fsmType, "sharedFsm");
  assertEquals(fulljson.states.idle.invoke[0].fsmVersion, "v02");
  assertEquals(childActorsInfo[0].child_actor_fsmType, "sharedFsm");
  assertEquals(childActorsInfo[0].child_actor_fsmVersion, "v02");
});

Deno.test("addMissingFsmTypeToInvokeActor - handles nested states", () => {
  const fsmJSON = {
    states: {
      outer: {
        states: {
          inner: {
            invoke: [{ src: "nestedActor" }],
          },
        },
      },
    },
  };
  const { childActorsInfo } = addMissingFsmTypeToInvokeActor(fsmJSON, "v01");
  assertEquals(childActorsInfo.length, 1);
  assertEquals(childActorsInfo[0].child_actor_src, "nestedActor");
});

Deno.test("addMissingFsmTypeToInvokeActor - handles root-level invoke", () => {
  const fsmJSON = {
    invoke: [{ src: "rootActor" }],
    states: {},
  };
  const { childActorsInfo } = addMissingFsmTypeToInvokeActor(fsmJSON, "v01");
  assertEquals(childActorsInfo.length, 1);
  assertEquals(childActorsInfo[0].child_actor_src, "rootActor");
});

Deno.test("addMissingFsmTypeToInvokeActor - returns empty childActorsInfo when no invoke", () => {
  const fsmJSON = { states: { idle: {} } };
  const { childActorsInfo } = addMissingFsmTypeToInvokeActor(fsmJSON, "v01");
  assertEquals(childActorsInfo.length, 0);
});

Deno.test("addMissingFsmTypeToInvokeActor - does not mutate original", () => {
  const fsmJSON = {
    states: { idle: { invoke: [{ src: "actor" }] } },
  };
  const original = JSON.stringify(fsmJSON);
  addMissingFsmTypeToInvokeActor(fsmJSON, "v01");
  assertEquals(JSON.stringify(fsmJSON), original);
});

// --- normalizeActionsToObjects unit tests ---

Deno.test("normalizeActionsToObjects - converts string entry/exit actions to { type }", () => {
  const input = {
    states: {
      idle: {
        entry: ["doEnter", "doAlso"],
        exit: ["doExit"],
      },
    },
  };
  const result = normalizeActionsToObjects(input);
  assertEquals(result.states.idle.entry, [{ type: "doEnter" }, { type: "doAlso" }]);
  assertEquals(result.states.idle.exit, [{ type: "doExit" }]);
});

Deno.test("normalizeActionsToObjects - converts string actions in on-transitions", () => {
  const input = {
    states: {
      idle: {
        on: {
          NEXT: [{ actions: ["assignFoo", "assignBar"], eventType: "NEXT", source: "idle", target: ["active"] }],
        },
      },
    },
  };
  const result = normalizeActionsToObjects(input);
  assertEquals(result.states.idle.on.NEXT[0].actions, [{ type: "assignFoo" }, { type: "assignBar" }]);
});

Deno.test("normalizeActionsToObjects - converts string actions in transitions array", () => {
  const input = {
    states: {
      idle: {
        transitions: [{ actions: ["doSomething"], eventType: "GO", source: "idle", target: ["done"] }],
      },
    },
  };
  const result = normalizeActionsToObjects(input);
  assertEquals(result.states.idle.transitions[0].actions, [{ type: "doSomething" }]);
});

Deno.test("normalizeActionsToObjects - converts string actions in initial transition", () => {
  const input = {
    initial: { actions: ["initAction"], source: "root", target: ["idle"] },
    states: { idle: {} },
  };
  const result = normalizeActionsToObjects(input);
  assertEquals(result.initial.actions, [{ type: "initAction" }]);
});

Deno.test("normalizeActionsToObjects - leaves existing actionObjects unchanged", () => {
  const input = {
    states: {
      idle: {
        entry: [{ type: "alreadyObject", extra: true }],
      },
    },
  };
  const result = normalizeActionsToObjects(input);
  assertEquals(result.states.idle.entry, [{ type: "alreadyObject", extra: true }]);
});

Deno.test("normalizeActionsToObjects - handles nested states recursively", () => {
  const input = {
    states: {
      outer: {
        states: {
          inner: {
            entry: ["nestedAction"],
          },
        },
      },
    },
  };
  const result = normalizeActionsToObjects(input);
  assertEquals(result.states.outer.states.inner.entry, [{ type: "nestedAction" }]);
});

Deno.test("normalizeActionsToObjects - does not mutate original", () => {
  const input = {
    states: { idle: { entry: ["doEnter"] } },
  };
  const original = JSON.stringify(input);
  normalizeActionsToObjects(input);
  assertEquals(JSON.stringify(input), original);
});

// --- generateFsmJSONFromFolders integration tests ---

const FSM_FOLDER = "packages/fsm-compiler-ts/src/example/fsm";
const SHARED_FSM_FOLDER = "packages/fsm-compiler-ts/src/example/sharedFSM";

Deno.test("generateFsmJSONFromFolders - generates fsm.json for fsm folder", async () => {
  await generateFsmJSONFromFolders(FSM_FOLDER, "fsm", []);

  const stat = await Deno.stat(`${FSM_FOLDER}/creditCheck/v01/fsm.json`);
  assertEquals(stat.isFile, true);
});

Deno.test("generateFsmJSONFromFolders - generates fsm.json for sharedFSM folder", async () => {
  await generateFsmJSONFromFolders(SHARED_FSM_FOLDER, "sharedFsm", []);

  const stat = await Deno.stat(`${SHARED_FSM_FOLDER}/vitalsWorkflow/v01/fsm.json`);
  assertEquals(stat.isFile, true);
});

Deno.test("generateFsmJSONFromFolders - showRecommendation=false produces no recommendation output", async () => {
  // Captures that the function completes without error when showRecommendation is false (default)
  await generateFsmJSONFromFolders(FSM_FOLDER, "fsm", [], false);
});

Deno.test("generateFsmJSONFromFolders - showRecommendation=true runs AJV validation without throwing", async () => {
  // Should complete without throwing even if schema issues exist
  await generateFsmJSONFromFolders(FSM_FOLDER, "fsm", [], true);
});

Deno.test("generateFsmJSONFromFolders - showRecommendation=true on sharedFSM runs AJV validation without throwing", async () => {
  await generateFsmJSONFromFolders(SHARED_FSM_FOLDER, "sharedFsm", [], true);
});

Deno.test("generateFsmJSONFromFolders - respects skipDirs", async () => {
  // carVitals is skipped — its fsm.json may or may not exist but no error is thrown
  await generateFsmJSONFromFolders(FSM_FOLDER, "fsm", ["carVitals"]);
});

Deno.test("generateFsmJSONFromFolders - throws on path starting with '.'", async () => {
  let threw = false;
  try {
    await generateFsmJSONFromFolders("./relative/path", "fsm");
  } catch (e) {
    threw = true;
    assertExists((e as Error).message.match(/cannot start with/i));
  }
  assertEquals(threw, true);
});

Deno.test("generateFsmJSONFromFolders - throws on path ending with '/'", async () => {
  let threw = false;
  try {
    await generateFsmJSONFromFolders("some/path/", "fsm");
  } catch (e) {
    threw = true;
    assertExists((e as Error).message.match(/cannot end with/i));
  }
  assertEquals(threw, true);
});
