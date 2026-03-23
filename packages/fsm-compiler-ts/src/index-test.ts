/**
 * Smoke test for src/index.ts — verifies all public exports are present and callable.
 * Run from repo root: deno run --allow-all packages/fsm-compiler-ts/src/index-test.ts
 */

import {
  addMissingFsmTypeToInvokeActor,
  deleteFsmJSONFromFolders,
  generateFsmJSONFromFolders,
  generateFsmPluginFromFolders,
  hasArity,
  isFunction,
  isTimestampFolderName,
  isValidDateFolderName,
  isVersionFolderName,
  loadAndVerifyFsmFromFolders,
  loadAndVerifyPromiseFromFolders,
  loadFsmJSONFromFolders,
  validateFsmPluginLoadFromFolder,
  validateFsmPluginLoadFromFolders,
  validateLanguageModules,
  validatePromisePluginLoadFromFolder,
  validatePromisePluginLoadFromFolders,
} from "./index.ts";

(async () => {
  console.log("=== index.ts exports ===\n");

  // Verify all exports are functions
  const exports = {
    generateFsmJSONFromFolders,
    addMissingFsmTypeToInvokeActor,
    generateFsmPluginFromFolders,
    loadFsmJSONFromFolders,
    loadAndVerifyFsmFromFolders,
    loadAndVerifyPromiseFromFolders,
    validateFsmPluginLoadFromFolders,
    validateFsmPluginLoadFromFolder,
    validatePromisePluginLoadFromFolders,
    validatePromisePluginLoadFromFolder,
    validateLanguageModules,
    isFunction,
    hasArity,
    deleteFsmJSONFromFolders,
    isVersionFolderName,
    isValidDateFolderName,
    isTimestampFolderName,
  };

  for (const [name, fn] of Object.entries(exports)) {
    console.assert(typeof fn === "function", `${name} should be a function`);
    console.log(`  ✅ ${name}`);
  }

  // Spot-check util functions
  console.assert(isVersionFolderName("v01") === true, "v01 is a valid version folder");
  console.assert(isVersionFolderName("v99") === true, "v99 is a valid version folder");
  console.assert(isVersionFolderName("v1") === false, "v1 is not a valid version folder");
  console.assert(isVersionFolderName("abc") === false, "abc is not a valid version folder");
  console.log("\n  ✅ isVersionFolderName checks pass");

  console.assert(isValidDateFolderName("2024-01-15-10-30") === true, "valid date folder");
  console.assert(isValidDateFolderName("not-a-date") === false, "invalid date folder");
  console.log("  ✅ isValidDateFolderName checks pass");

  console.assert(isTimestampFolderName("20240115103000") === true, "valid timestamp folder");
  console.assert(isTimestampFolderName("2024") === false, "invalid timestamp folder");
  console.log("  ✅ isTimestampFolderName checks pass");

  // isFunction / hasArity checks
  console.assert(isFunction(() => {}) === true, "arrow fn is a function");
  console.assert(isFunction(42) === false, "number is not a function");
  console.assert(hasArity(2)((_a: unknown, _b: unknown) => {}) === true, "arity 2 matches");
  console.assert(hasArity(2)((_a: unknown) => {}) === false, "arity 1 does not match 2");
  console.log("  ✅ isFunction / hasArity checks pass");

  console.log("\n=== index.ts exports complete ===");
})();
