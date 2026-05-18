# fsm-compiler-ts — Naming Suggestions

> **All suggestions in this document have been implemented.**

Suggestions to improve consistency between source files, exported functions, CLI commands, and parameter names.

---

## 1. Parameter Names — `workflow_type` → `workflowType`

**Priority: Critical**

Every public function in this package uses `workflow_type` (snake_case) as a parameter name, while every other parameter uses camelCase. This is the single most pervasive inconsistency.

| Function | File | Current Param | Suggested Param |
|---|---|---|---|
| `generateFsmJSONFromFolders` | `generateFsmJSON.ts` | `workflow_type` | `workflowType` |
| `generateFsmJSONFromFolder` (internal) | `generateFsmJSON.ts` | `workflow_type` | `workflowType` |
| `generateFsmPluginFromFolders` | `generateFsmPlugin.ts` | `workflow_type` | `workflowType` |
| `generateFsmPluginFromFolder` (internal) | `generateFsmPlugin.ts` | `workflow_type` | `workflowType` |
| `deleteFsmJSONFromFolders` | `cleanFsmJSON.ts` | `workflow_type` | `workflowType` |
| `deleteFsmJSONFromFolder` (internal) | `cleanFsmJSON.ts` | `workflow_type` | `workflowType` |
| `loadFsmJSONFromFolders` | `loadFsmJSON.ts` | `workflow_type` | `workflowType` |
| `loadFsmJSONFromFolder` (internal) | `loadFsmJSON.ts` | `workflow_type` | `workflowType` |
| `loadAndVerifyFsmFromFolders` | `loadAndVerifyFsm.ts` | `workflow_type` | `workflowType` |
| `loadAndVerifyPromiseFromFolders` | `loadAndVerifyFsm.ts` | `workflow_type` | `workflowType` |
| `validateFsmPluginLoadFromFolders` | `validateFsmPluginLoad.ts` | `workflow_type` | `workflowType` |
| `validateFsmPluginLoadFromFolder` | `validateFsmPluginLoad.ts` | `workflow_type` | `workflowType` |
| `validatePromisePluginLoadFromFolders` | `validateFsmPluginLoad.ts` | `workflow_type` | `workflowType` |
| `validatePromisePluginLoadFromFolder` | `validateFsmPluginLoad.ts` | `workflow_type` | `workflowType` |

---

## 2. File Name vs Export Name Mismatch — `cleanFsmJSON.ts` / `deleteFsmJSONFromFolders`

**Priority: Critical**

The file is named `cleanFsmJSON.ts` but its exported function is `deleteFsmJSONFromFolders`. The CLI command for this is `clean`. All three use different verbs for the same operation.

| Layer | Current | Suggested |
|---|---|---|
| File name | `cleanFsmJSON.ts` | `deleteFsmJSON.ts` |
| Exported function | `deleteFsmJSONFromFolders` | *(keep — matches "delete" verb)* |
| CLI command | `clean` | `delete` |

Pick one verb — `delete` is the most precise. Rename the file and CLI command to match the function.

---

## 3. Redundant `fsm` Prefix in Validation Function Parameters

**Priority: Medium**

`validateFsmPluginLoadFromFolder` and `validatePromisePluginLoadFromFolder` take 7+ parameters all prefixed with `fsm`. Since the function name already scopes these to FSM context, the prefix adds noise without clarity.

| Current Param | Suggested Param |
|---|---|
| `fsmDirName` | `dirName` |
| `fsmVersionDirName` | `versionName` |
| `fsmAbsFolderPath` | `absPath` |
| `fsmRelativeFolderPath` | `relPath` |
| `fsmParentDirName` | `parentDirName` |
| `fsmParentAbsFolderPath` | `parentAbsPath` |
| `fsmParentRelativeFolderPath` | `parentRelPath` |

---

## 4. Missing Named Types for Recurring Inline Shapes

**Priority: Medium**

Several anonymous object shapes appear across multiple files. Extracting them as named types in `util.ts` (or a new `types.ts`) would reduce repetition and improve IDE support.

| Shape | Used In | Suggested Type Name |
|---|---|---|
| `{ src: string; fsmType?: string; fsmVersion?: string }` | `validateFsmPluginLoad.ts`, `generateFsmPlugin.ts`, `loadAndVerifyFsm.ts` | `ActorReference` |
| `{ method: string; moduleType: string; modulePath: string }` | `validateFsmPluginLoad.ts` (multiple functions) | `FailedMethod` |
| `{ src: string; fsmName: string; fsmType: string; fsmVersion: string; fsmAbsFolderPath: string; fsmRelativeFolderPath: string; ... }` | return types in `validateFsmPluginLoad.ts` | `FsmPluginValidationResult` |

---

## 5. `addMissingFsmTypeToInvokeActor` — Inconsistent Singular/Plural

**Priority: Low**

All other exported functions that operate on collections use the plural form in their name (`generateFsmJSONFromFolders`, `validateFsmPluginLoadFromFolders`, etc.). This function processes all `invoke` entries in a JSON tree but its name is singular (`InvokeActor`).

| Current | Suggested | Reason |
|---|---|---|
| `addMissingFsmTypeToInvokeActor` | `addMissingFsmTypeToInvokeActors` | Plural to match processing-multiple-entries behaviour |

---

## 6. `validatePromisePluginLoadFromFolders` — No CLI Command

**Priority: Low**

`validatePromisePluginLoadFromFolders` is exported from `index.ts` but has no CLI command. By contrast, `validateFsmPluginLoadFromFolders` has the `validate` command. If promise validation is intentionally CLI-only via library, add a code comment. Otherwise, add a `validate-promise` CLI command for symmetry.

| Exported Function | CLI Command |
|---|---|
| `validateFsmPluginLoadFromFolders` | `validate` ✅ |
| `validatePromisePluginLoadFromFolders` | *(none)* ❌ |
