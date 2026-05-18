# fsm-compiler-ts — CLI Gaps

> **All gaps marked ❌ in sections 1–4 have been implemented.** Test coverage gaps (section 5) remain open.

Audit of `src/cli/index.ts` against the actual function signatures in `src/index.ts`.

---

## 1. Missing Flags per Command

### `generate`
Calls: `generateFsmJSONFromFolders(folder, "fsm", [], showRecommendation)` (line 92)

| Parameter | CLI Flag | Status | Impact |
|---|---|---|---|
| `folderPath` | `-f, --folder` | ✅ | — |
| `workflow_type` | `-w, --workflow-type` | ❌ hardcoded `"fsm"` | Cannot generate for `sharedFsm` or `sharedPromise` folders |
| `skipDirs` | `--skip-dirs` | ❌ hardcoded `[]` | Cannot exclude subdirectories |
| `showRecommendation` | `-r, --show-recommendation` | ✅ | — |

### `generate-plugin`
Calls: `generateFsmPluginFromFolders(folder, "fsm")` (line 95)

| Parameter | CLI Flag | Status | Impact |
|---|---|---|---|
| `folderPath` | `-f, --folder` | ✅ | — |
| `workflow_type` | `-w, --workflow-type` | ❌ hardcoded `"fsm"` | Cannot generate plugins for `sharedFsm` folders |
| `skipDirs` | `--skip-dirs` | ❌ hardcoded `[]` | Cannot exclude subdirectories |

### `clean`
Calls: `deleteFsmJSONFromFolders(folder, "fsm")` (line 98)

| Parameter | CLI Flag | Status | Impact |
|---|---|---|---|
| `folderPath` | `-f, --folder` | ✅ | — |
| `workflow_type` | `-w, --workflow-type` | ❌ hardcoded `"fsm"` | Cannot clean `sharedFsm` or `sharedPromise` folders |
| `skipDirs` | `--skip-dirs` | ❌ hardcoded `[]` | Cannot exclude subdirectories |

### `validate`
Calls: `validateFsmPluginLoadFromFolders(folder, workflowType)` (line 101)

| Parameter | CLI Flag | Status | Impact |
|---|---|---|---|
| `folderPath` | `-f, --folder` | ✅ | — |
| `workflow_type` | `-w, --workflow-type` | ✅ | — |
| `skipDirs` | `--skip-dirs` | ❌ hardcoded `[]` | Cannot exclude subdirectories |
| `availableActors` | `--available-actors` | ❌ hardcoded `[]` | External actor dependencies always reported as unresolved |

### `load`
Calls: `loadFsmJSONFromFolders(folder, workflowType, [], deps)` (line 105)

| Parameter | CLI Flag | Status | Impact |
|---|---|---|---|
| `folderPath` | `-f, --folder` | ✅ | — |
| `workflow_type` | `-w, --workflow-type` | ✅ | — |
| `skipDirs` | `--skip-dirs` | ❌ hardcoded `[]` | Cannot exclude subdirectories |
| `deps` | env var `DATABASE_URL` | ⚠️ implicit | No early validation; fails mid-run if missing |

### `load-and-validate`
Calls: `loadAndValidateFsmFromFolders(deps, folder, workflowType)` (line 110)

| Parameter | CLI Flag | Status | Impact |
|---|---|---|---|
| `deps` | env var `DATABASE_URL` | ⚠️ implicit | No early validation |
| `folderPath` | `-f, --folder` | ✅ | — |
| `workflow_type` | `-w, --workflow-type` | ✅ | — |
| `skipDirs` | `--skip-dirs` | ❌ not passed | Cannot exclude subdirectories |
| `availableActors` | `--available-actors` | ❌ not passed | External actor dependencies always unresolved |

### `load-and-validate-promise`
Calls: `loadAndValidatePromiseFromFolders(deps, folder, workflowType)` (line 115)

| Parameter | CLI Flag | Status | Impact |
|---|---|---|---|
| `deps` | env var `DATABASE_URL` | ⚠️ implicit | No early validation |
| `folderPath` | `-f, --folder` | ✅ | — |
| `workflow_type` | `-w, --workflow-type` | ✅ | — |
| `skipDirs` | `--skip-dirs` | ❌ not passed | Cannot exclude subdirectories |
| `availableActors` | `--available-actors` | ❌ not passed | External actor dependencies always unresolved |

---

## 2. Exported Functions with No CLI Command

| Exported Function | CLI Command | Note |
|---|---|---|
| `validatePromisePluginLoadFromFolders` | *(none)* | Gap — `validateFsmPluginLoadFromFolders` has `validate`; this has no equivalent |
| `addMissingFsmTypeToInvokeActor` | *(none)* | Intentional — internal transform, library-only |
| `normalizeActionsToObjects` | *(none)* | Intentional — internal transform, library-only |
| `addActionNameFromDelay` | *(none)* | Intentional — internal transform, library-only |
| `validateFsmPluginLoadFromFolder` | *(none)* | Intentional — single-folder variant called by the folders variant |
| `validatePromisePluginLoadFromFolder` | *(none)* | Intentional — same |
| `validateLanguageModules` | *(none)* | Intentional — called internally by validate functions |
| `isFunction`, `hasArity` | *(none)* | Intentional — utility predicates |

**Suggested addition:** Add a `validate-promise` command that calls `validatePromisePluginLoadFromFolders`.

---

## 3. Input Validation Gaps

| Gap | Location | Severity |
|---|---|---|
| `--workflow-type` accepts any string | line 68 | High — invalid types (e.g. `--workflow-type foobar`) silently pass validation and cause internal errors; should validate against `"fsm" \| "sharedFsm" \| "sharedPromise" \| "promise"` |
| No check that `--folder` path exists | lines 72-81 | Medium — functions fail mid-execution with confusing directory errors instead of an upfront message |
| No check for `DATABASE_URL` before DB commands | lines 83-116 | High — `buildDeps()` creates a Pool with `undefined` connection string; error surfaces on first query, not at startup |

---

## 4. Help Text Gaps

Location: `src/cli/index.ts` lines 27-58.

| Issue | Severity |
|---|---|
| `-w, --workflow-type` documented as "required for validate, load, load-and-validate, load-and-validate-promise" — but `generate`, `generate-plugin`, and `clean` also accept it (it is just ignored, hardcoded to `"fsm"`) | Medium |
| `--skip-dirs` flag does not exist in the CLI but is accepted by all underlying functions | High — users have no way to use this feature |
| `--available-actors` flag does not exist in the CLI but is accepted by `validate`, `load-and-validate`, `load-and-validate-promise` | High — external actor dependencies always reported as unresolved |
| `DATABASE_URL` env var requirement not mentioned for `load`, `load-and-validate`, `load-and-validate-promise` | High — silent failures when env var is missing |
| `--show-recommendation` only applies to `generate` but help text does not say so | Low |

---

## 5. Test Coverage Gaps

Test files: `test/cli.test.ts`, `src/cli/index-test.ts`.

| Command / Scenario | Tested? |
|---|---|
| `--help` / `-h` | ✅ |
| `generate` (success) | ✅ |
| `generate --show-recommendation` / `-r` | ✅ |
| `validate` (success) | ✅ |
| `validate -w` shorthand | ✅ |
| `generate-plugin` | ❌ |
| `clean` | ❌ |
| `load` | ❌ (needs DB) |
| `load-and-validate` | ❌ (needs DB) |
| `load-and-validate-promise` | ❌ (needs DB) |
| Invalid `--workflow-type` value | ❌ |
| `--folder` path that does not exist | ❌ |
| Missing `DATABASE_URL` for DB commands | ❌ |
