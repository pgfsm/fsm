# fsm-compiler-ts — Naming Suggestions

Suggestions to improve consistency between source files, exported functions, CLI commands, and parameter names.

---

## Summary

| # | Issue | Status |
|---|-------|--------|
| 1 | `workflow_type` → `workflowType` in all function params | ✅ Implemented |
| 2 | `cleanFsmJSON.ts` / `clean` → `deleteFsmJSONFromFolders.ts` / `delete` | ✅ Implemented |
| 3 | Strip `fsm` prefix from validation function parameters | ✅ Implemented |
| 4 | Extract `FsmPluginValidationResult` named type | ✅ Implemented |
| 5 | `addMissingFsmTypeToInvokeActor` → plural `...InvokeActors` | ✅ Implemented |
| 6 | Add `validate-promise` CLI command for `validatePromisePluginLoadFromFolders` | ✅ Implemented |
| 7 | `loadAndVerify*` → `loadAndValidate*` | ✅ Implemented |
| 8 | CLI `validate` → `validate-plugin`, `validate-promise` → `validate-promise-plugin` | ✅ Implemented |

---

## 1. `workflow_type` → `workflowType` ✅ Implemented

Every public function previously used `workflow_type` (snake_case) while all other parameters were camelCase.

| Function | File | Was | Is now | Status |
|---|---|---|---|---|
| `generateFsmJSONFromFolders` | `generateFsmJSON.ts` | `workflow_type` | `workflowType` | ✅ |
| `generateFsmJSONFromFolder` (internal) | `generateFsmJSON.ts` | `workflow_type` | `workflowType` | ✅ |
| `generateFsmPluginFromFolders` | `generateFsmPlugin.ts` | `workflow_type` | `workflowType` | ✅ |
| `generateFsmPluginFromFolder` (internal) | `generateFsmPlugin.ts` | `workflow_type` | `workflowType` | ✅ |
| `deleteFsmJSONFromFolders` | `deleteFsmJSONFromFolders.ts` | `workflow_type` | `workflowType` | ✅ |
| `deleteFsmJSONFromFolder` (internal) | `deleteFsmJSONFromFolders.ts` | `workflow_type` | `workflowType` | ✅ |
| `loadFsmJSONFromFolders` | `loadFsmJSON.ts` | `workflow_type` | `workflowType` | ✅ |
| `loadFsmJSONFromFolder` (internal) | `loadFsmJSON.ts` | `workflow_type` | `workflowType` | ✅ |
| `loadAndValidateFsmFromFolders` | `loadAndValidateFsm.ts` | `workflow_type` | `workflowType` | ✅ |
| `loadAndValidatePromiseFromFolders` | `loadAndValidateFsm.ts` | `workflow_type` | `workflowType` | ✅ |
| `validateFsmPluginLoadFromFolders` | `validateFsmPluginLoad.ts` | `workflow_type` | `workflowType` | ✅ |
| `validateFsmPluginLoadFromFolder` | `validateFsmPluginLoad.ts` | `workflow_type` | `workflowType` | ✅ |
| `validatePromisePluginLoadFromFolders` | `validateFsmPluginLoad.ts` | `workflow_type` | `workflowType` | ✅ |
| `validatePromisePluginLoadFromFolder` | `validateFsmPluginLoad.ts` | `workflow_type` | `workflowType` | ✅ |

---

## 2. File Name / CLI Command — `clean` → `delete` ✅ Implemented

The file was named `cleanFsmJSON.ts` but exported `deleteFsmJSONFromFolders`. The CLI command was `clean`. All three used different verbs.

| Layer | Was | Is now | Status |
|---|---|---|---|
| File name | `cleanFsmJSON.ts` | `deleteFsmJSONFromFolders.ts` | ✅ |
| Exported function | `deleteFsmJSONFromFolders` | *(unchanged)* | ✅ |
| CLI command | `clean` | `delete` | ✅ |

---

## 3. Strip `fsm` Prefix from Validation Function Parameters ✅ Implemented

`validateFsmPluginLoadFromFolder` and `validatePromisePluginLoadFromFolder` previously took 7+ parameters all prefixed with `fsm`. The function name already scopes them.

| Was | Is now | Status |
|---|---|---|
| `fsmDirName` | `dirName` | ✅ |
| `fsmVersionDirName` | `versionName` | ✅ |
| `fsmAbsFolderPath` | `absPath` | ✅ |
| `fsmRelativeFolderPath` | `relPath` | ✅ |
| `fsmParentDirName` | `parentDirName` | ✅ |
| `fsmParentAbsFolderPath` | `parentAbsPath` | ✅ |
| `fsmParentRelativeFolderPath` | `parentRelPath` | ✅ |

---

## 4. Extract Named Types for Recurring Inline Shapes ✅ Implemented

Anonymous object shapes that appeared across multiple files are now named types in `util.ts` and exported from `index.ts`.

| Shape | Suggested Type Name | Status |
|---|---|---|
| `{ src: string; fsmType?: string; fsmVersion?: string }` | `ActorReference` | ✅ — in `util.ts` |
| `{ method: string; moduleType: string; modulePath: string }` | `FailedMethod` | ✅ — in `util.ts` |
| Internal actor shape with `fsmName`, `fsmAbsFolderPath`, `fsmRelativeFolderPath` | `InternalActor` | ✅ — in `util.ts` |
| External actor shape with `resolved: boolean` | `ExternalActor` | ✅ — in `util.ts` |
| Full validation result returned by `validateFsmPluginLoadFromFolder` | `FsmPluginValidationResult` | ✅ — in `util.ts` |

All four `validate*` functions in `validateFsmPluginLoad.ts` now have explicit `Promise<FsmPluginValidationResult>` / `Promise<FsmPluginValidationResult[]>` return types.

---

## 5. `addMissingFsmTypeToInvokeActor` → Plural ✅ Implemented

All exported functions that process collections use the plural form. This function processes all `invoke` entries in a JSON tree but was named in the singular.

| Was | Is now | Status |
|---|---|---|
| `addMissingFsmTypeToInvokeActor` | `addMissingFsmTypeToInvokeActors` | ✅ |

---

## 6. `validatePromisePluginLoadFromFolders` — Add CLI Command ✅ Implemented

`validatePromisePluginLoadFromFolders` was exported but had no CLI command while its FSM counterpart had `validate`.

| Exported Function | CLI Command | Status |
|---|---|---|
| `validateFsmPluginLoadFromFolders` | `validate-plugin` | ✅ |
| `validatePromisePluginLoadFromFolders` | `validate-promise-plugin` | ✅ |

---

## 7. `loadAndVerify*` → `loadAndValidate*` ✅ Implemented

`verify` was the only verb in the package not aligned with `validate`.

| Was | Is now | File | Status |
|---|---|---|---|
| `loadAndVerifyFsmFromFolders` | `loadAndValidateFsmFromFolders` | `loadAndValidateFsm.ts` (was `loadAndVerifyFsm.ts`) | ✅ |
| `loadAndVerifyPromiseFromFolders` | `loadAndValidatePromiseFromFolders` | `loadAndValidateFsm.ts` | ✅ |

---

## 8. CLI Commands — `validate` → `validate-plugin` ✅ Implemented

`validate` was ambiguous — it could mean "validate the fsm.json schema" or "validate the TypeScript plugin module exports". It's the latter. `validate-plugin` makes the target explicit. The sister command follows the same pattern for symmetry.

| Was | Is now | Calls | Status |
|---|---|---|---|
| `validate` | `validate-plugin` | `validateFsmPluginLoadFromFolders` | ✅ |
| `validate-promise` | `validate-promise-plugin` | `validatePromisePluginLoadFromFolders` | ✅ |
