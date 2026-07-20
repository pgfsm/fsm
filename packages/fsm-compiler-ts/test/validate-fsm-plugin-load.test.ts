import { assertEquals } from "@std/assert";
import {
  hasArity,
  isFunction,
  validateSyncOperationFromFolder,
} from "../src/validate-sync-operation-logic.ts";
import type { FsmMachineJson } from "../src/generated/fsm-machine-schema.types.ts";

// isFunction
Deno.test("isFunction - returns true for functions", () => {
  assertEquals(isFunction(() => {}), true);
  assertEquals(isFunction(function () {}), true);
  assertEquals(isFunction(async () => {}), true);
  assertEquals(isFunction(class {}), true);
});

Deno.test("isFunction - returns false for non-functions", () => {
  assertEquals(isFunction(42), false);
  assertEquals(isFunction("string"), false);
  assertEquals(isFunction(null), false);
  assertEquals(isFunction(undefined), false);
  assertEquals(isFunction({}), false);
  assertEquals(isFunction([]), false);
});

// hasArity (curried: hasArity(n)(fn))
Deno.test("hasArity - matches correct arity", () => {
  assertEquals(hasArity(0)(() => {}), true);
  assertEquals(hasArity(1)((_a: unknown) => {}), true);
  assertEquals(hasArity(2)((_a: unknown, _b: unknown) => {}), true);
  assertEquals(
    hasArity(3)((_a: unknown, _b: unknown, _c: unknown) => {}),
    true,
  );
});

Deno.test("hasArity - rejects wrong arity", () => {
  assertEquals(hasArity(2)((_a: unknown) => {}), false);
  assertEquals(hasArity(1)((_a: unknown, _b: unknown) => {}), false);
  assertEquals(hasArity(0)((_a: unknown) => {}), false);
});

Deno.test("hasArity - returns false for non-functions", () => {
  assertEquals(hasArity(1)(42), false);
  assertEquals(hasArity(0)(null), false);
  assertEquals(hasArity(2)("string"), false);
});

// validateSyncOperationFromFolder - early return on schema failure
Deno.test("validateSyncOperationFromFolder - returns defaults when fsm.json fails schema", async () => {
  // Intentionally malformed to exercise the AJV rejection path — cast past
  // the compile-time contract since real callers always pass parsed JSON.
  const invalidFsmData = { not: "a valid fsm" } as unknown as FsmMachineJson;

  const result = await validateSyncOperationFromFolder(
    invalidFsmData,
    "testFsm",
    "v01",
    "/tmp/nonexistent/testFsm/v01",
    "testFsm/v01",
    "testParent",
    "/tmp/nonexistent",
    "testParent",
    "fsm",
    [],
  );

  assertEquals(result.fsmJsonPresent, true);
  assertEquals(result.fsmJsonFollowSchema, false);
  assertEquals(result.isFsmModuleVerified, false);
  assertEquals(result.failedMethods, []);
  assertEquals(result.asyncOperationActors, []);
  assertEquals(result.fsmModuleDefinition, undefined);
  assertEquals(result.fsmName, "testFsm");
  assertEquals(result.fsmVersion, "v01");
  assertEquals(result.fsmType, "fsm");
});
