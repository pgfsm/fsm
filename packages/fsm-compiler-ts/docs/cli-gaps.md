# fsm-compiler-ts — CLI Gaps

Audit of `src/cli/index.ts` against the actual function signatures in `src/index.ts`.

Sections 1–4 are fully closed. Test coverage gaps (section 5) remain open.

---

## 1. Missing Flags per Command

### `generate`

Path-aware routing — detects input type from `Deno.stat` + file extension:

- **directory** → `generateFsmJSONFromFolders(folder, workflowType ?? "fsm", skipDirs, showRecommendation)`
- **`.ts` file** → `generateFsmJSONFromMachineFile(absDir, version, workflowType ?? "fsm", showRecommendation)`
- **`.json` file** → `generateFsmJSONFromConfigFile(absPath, workflowType ?? "fsm", showRecommendation)`

| Parameter | CLI Flag | Status | Impact |
|---|---|---|---|
| `folderPath` / `absDir` / `absPath` | `-f, --folder` | ✅ | — |
| `workflowType` | `-w, --workflow-type` | ✅ honours flag, defaults to `"fsm"` | — |
| `skipDirs` | `-s, --skip-dirs` | ✅ passed through (directory mode only) | — |
| `showRecommendation` | `-r, --show-recommendation` | ✅ | — |
| Path type detection | (inferred from `Deno.stat` + extension) | ✅ | — |

### `generate-plugin`
Calls: `generateFsmPluginFromFolders(folder, workflowType ?? "fsm", skipDirs)` (line 137)

| Parameter | CLI Flag | Status | Impact |
|---|---|---|---|
| `folderPath` | `-f, --folder` | ✅ | — |
| `workflowType` | `-w, --workflow-type` | ✅ honours flag, defaults to `"fsm"` | — |
| `skipDirs` | `-s, --skip-dirs` | ✅ parsed and passed through | — |

### `delete`
Calls: `deleteFsmJSONFromFolders(folder, workflowType ?? "fsm", skipDirs)` (line 140)

| Parameter | CLI Flag | Status | Impact |
|---|---|---|---|
| `folderPath` | `-f, --folder` | ✅ | — |
| `workflowType` | `-w, --workflow-type` | ✅ honours flag, defaults to `"fsm"` | — |
| `skipDirs` | `-s, --skip-dirs` | ✅ parsed and passed through | — |

### `validate-plugin`
Calls: `validateFsmPluginLoadFromFolders(folder, workflowType, skipDirs, availableActors)` (line 144)

| Parameter | CLI Flag | Status | Impact |
|---|---|---|---|
| `folderPath` | `-f, --folder` | ✅ | — |
| `workflowType` | `-w, --workflow-type` | ✅ | — |
| `skipDirs` | `-s, --skip-dirs` | ✅ parsed and passed through | — |
| `availableActors` | `-a, --available-actors` | ✅ loaded from JSON file via `loadAvailableActors()` | — |

### `load`
Calls: `loadFsmJSONFromFolders(folder, workflowType, skipDirs, deps)` (line 154)

| Parameter | CLI Flag | Status | Impact |
|---|---|---|---|
| `folderPath` | `-f, --folder` | ✅ | — |
| `workflowType` | `-w, --workflow-type` | ✅ | — |
| `skipDirs` | `-s, --skip-dirs` | ✅ parsed and passed through | — |
| `deps` | `-d, --db-url` or `DATABASE_URL` | ✅ `buildDeps()` prefers `--db-url`, falls back to env var, exits with clear error if neither set | — |

### `load-and-validate`
Calls: `loadAndValidateFsmFromFolders(deps, folder, workflowType, skipDirs, availableActors)` (line 159)

| Parameter | CLI Flag | Status | Impact |
|---|---|---|---|
| `deps` | `-d, --db-url` or `DATABASE_URL` | ✅ same as `load` | — |
| `folderPath` | `-f, --folder` | ✅ | — |
| `workflowType` | `-w, --workflow-type` | ✅ | — |
| `skipDirs` | `-s, --skip-dirs` | ✅ parsed and passed through | — |
| `availableActors` | `-a, --available-actors` | ✅ loaded from JSON file via `loadAvailableActors()` | — |

### `load-and-validate-promise`
Calls: `loadAndValidatePromiseFromFolders(deps, folder, workflowType, skipDirs, availableActors)` (line 165)

| Parameter | CLI Flag | Status | Impact |
|---|---|---|---|
| `deps` | `-d, --db-url` or `DATABASE_URL` | ✅ same as `load` | — |
| `folderPath` | `-f, --folder` | ✅ | — |
| `workflowType` | `-w, --workflow-type` | ✅ | — |
| `skipDirs` | `-s, --skip-dirs` | ✅ parsed and passed through | — |
| `availableActors` | `-a, --available-actors` | ✅ loaded from JSON file via `loadAvailableActors()` | — |

---

## 2. Exported Functions with No CLI Command

| Exported Function | CLI Command | Note |
|---|---|---|
| `validateFsmPluginLoadFromFolders` | `validate-plugin` | ✅ |
| `validatePromisePluginLoadFromFolders` | `validate-promise-plugin` | ✅ added |
| `generateFsmJSONFromMachineFile` | `generate` (when `-f` is a `.ts` file) | ✅ |
| `generateFsmJSONFromConfigFile` | `generate` (when `-f` is a `.json` file) | ✅ |
| `addMissingFsmTypeToInvokeActors` | *(none)* | Intentional — internal transform, library-only |
| `normalizeActionsToObjects` | *(none)* | Intentional — internal transform, library-only |
| `addActionNameFromDelay` | *(none)* | Intentional — internal transform, library-only |
| `validateFsmPluginLoadFromFolder` | *(none)* | Intentional — single-folder variant called by the folders variant |
| `validatePromisePluginLoadFromFolder` | *(none)* | Intentional — same |
| `validateLanguageModules` | *(none)* | Intentional — called internally by validate functions |
| `isFunction`, `hasArity` | *(none)* | Intentional — utility predicates |

---

## 3. Input Validation Gaps

| Gap | Location | Status | Severity |
|---|---|---|---|
| `--workflow-type` accepts any string | startup (lines 87–91) | ✅ Fixed — validated against `VALID_WORKFLOW_TYPES` at startup, exits with error | High |
| No check that `--folder` path exists | after missing-args block | ✅ Fixed — `Deno.stat(folder)` check exits with a clear error if missing or not a directory | Medium |
| No early check for DB connection string | `buildDeps()` (lines 118–129) | ✅ Fixed — exits with a clear error message if neither `--db-url` nor `DATABASE_URL` is set | High |
| `--folder` rejected non-directories for `generate` | stat check block | ✅ Fixed — `isDirectory` assertion skipped when `command === "generate"` | Medium |

---

## 4. Help Text Gaps

Location: `src/cli/index.ts` lines 32–73.

| Issue | Status |
|---|---|
| `--skip-dirs` flag missing from help and CLI | ✅ Fixed — flag exists, documented in help, passed to all commands |
| `--available-actors` flag missing from help and CLI | ✅ Fixed — flag exists, documented in help, passed to validate and load-and-validate commands |
| `DATABASE_URL` env var not mentioned for DB commands | ✅ Fixed — documented under `ENVIRONMENT` in help text |
| `--show-recommendation` not scoped to `generate` in help | ✅ Fixed — help text notes it applies to `generate` only |
| `-w` description says optional for `generate/delete` but omits `generate-plugin` | ✅ Fixed — now says "optional for generate, generate-plugin, delete" |

---

## 5. Test Coverage Gaps

Test files: `test/cli.test.ts`, `src/cli/index-test.ts`.

| Command / Scenario | Tested? |
|---|---|
| `--help` / `-h` | ✅ |
| no args → help | ✅ |
| `generate` (success) | ✅ |
| `generate --show-recommendation` / `-r` | ✅ |
| `generate-plugin` | ✅ |
| `delete` | ✅ |
| `validate-plugin` (success) | ✅ |
| `validate-plugin -w` shorthand | ✅ |
| `validate-promise-plugin` | ✅ |
| Invalid `--workflow-type` value | ✅ |
| `--folder` path that does not exist | ✅ |
| Missing DB connection string for DB commands | ✅ |
| `--db-url` flag accepted and parsed | ✅ |
| `--skip-dirs` flag | ✅ |
| `--available-actors` flag | ✅ |
| `generate` with `.ts` file path | ❌ (not yet tested) |
| `generate` with `.json` file path | ❌ (not yet tested) |
| `load` (real DB) | ❌ (needs DB) |
| `load-and-validate` (real DB) | ❌ (needs DB) |
| `load-and-validate-promise` (real DB) | ❌ (needs DB) |
