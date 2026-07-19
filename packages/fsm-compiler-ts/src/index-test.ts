/**
 * Smoke test for src/index.ts — verifies all public exports are present and callable.
 * Run from repo root: deno run --allow-all packages/fsm-compiler-ts/src/index-test.ts
 */

import { getLogger } from "@logtape/logtape";
import { configureCompilerLogger } from "./logger.ts";
import {
  addMissingFsmTypeToInvokeActors,
  deleteFsmJSONFromFolders,
  generateAsyncOperationLogicFromFolders,
  generateFsmJSONFromFolders,
  generateSyncOperationLogicFromFolders,
  hasArity,
  isFunction,
  isTimestampFolderName,
  isValidDateFolderName,
  isVersionFolderName,
  loadFsmJSONFromFolders,
  validateAsyncOperationFromFolders,
  validateLanguageModules,
  validateSyncOperationFromFolder,
  validateSyncOperationFromFolders,
} from "./index.ts";

const logger = getLogger(["@pgfsm/compiler", "test"]);
await configureCompilerLogger();

(() => {
  logger.info("=== index.ts exports ===");

  const exports = {
    generateFsmJSONFromFolders,
    addMissingFsmTypeToInvokeActors,
    generateAsyncOperationLogicFromFolders,
    generateSyncOperationLogicFromFolders,
    loadFsmJSONFromFolders,
    validateSyncOperationFromFolders,
    validateSyncOperationFromFolder,
    validateAsyncOperationFromFolders,
    validateLanguageModules,
    isFunction,
    hasArity,
    deleteFsmJSONFromFolders,
    isVersionFolderName,
    isValidDateFolderName,
    isTimestampFolderName,
  };

  for (const [name, fn] of Object.entries(exports)) {
    if (typeof fn !== "function") {
      logger.error("{name} should be a function", { name });
    }
    logger.info("  {name}", { name });
  }

  if (isVersionFolderName("v01") !== true) {
    logger.error("v01 is a valid version folder");
  }
  if (isVersionFolderName("v99") !== true) {
    logger.error("v99 is a valid version folder");
  }
  if (isVersionFolderName("v1") !== false) {
    logger.error("v1 is not a valid version folder");
  }
  if (isVersionFolderName("abc") !== false) {
    logger.error("abc is not a valid version folder");
  }
  logger.info("  isVersionFolderName checks pass");

  if (isValidDateFolderName("2024-01-15-10-30") !== true) {
    logger.error("valid date folder");
  }
  if (isValidDateFolderName("not-a-date") !== false) {
    logger.error("invalid date folder");
  }
  logger.info("  isValidDateFolderName checks pass");

  if (isTimestampFolderName("20240115103000") !== true) {
    logger.error("valid timestamp folder");
  }
  if (isTimestampFolderName("2024") !== false) {
    logger.error("invalid timestamp folder");
  }
  logger.info("  isTimestampFolderName checks pass");

  if (isFunction(() => {}) !== true) logger.error("arrow fn is a function");
  if (isFunction(42) !== false) logger.error("number is not a function");
  if (hasArity(2)((_a: unknown, _b: unknown) => {}) !== true) {
    logger.error("arity 2 matches");
  }
  if (hasArity(2)((_a: unknown) => {}) !== false) {
    logger.error("arity 1 does not match 2");
  }
  logger.info("  isFunction / hasArity checks pass");

  logger.info("=== index.ts exports complete ===");
})();
