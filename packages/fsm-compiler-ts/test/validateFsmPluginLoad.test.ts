import { assertEquals } from "@std/assert";
import { hasArity, isFunction } from "../src/validateFsmPluginLoad.ts";

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
  assertEquals(hasArity(3)((_a: unknown, _b: unknown, _c: unknown) => {}), true);
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
