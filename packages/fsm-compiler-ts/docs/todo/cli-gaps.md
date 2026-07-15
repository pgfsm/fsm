# fsm-compiler-ts — CLI Gaps

**npm package:** `@pgfsm/compiler`

Audit of `src/cli/index.ts` against the actual function signatures in
`src/index.ts`.

Sections 1–4 are fully closed. Test coverage gaps (section 5) remain open.

---

## 1. Missing Flags per Command

### `generate`

Path-aware routing — detects input type from `Deno.stat` + file extension:

- **directory** →
  `generateFsmJSONFromFolders(folder, workflowType ?? "fsm", skipDirs, showRecommendation)`
- **`.ts` file** →
  `generateFsmJSONFromMachineFile(absDir, version, workflowType ?? "fsm", showRecommendation)`

| Parameter                           | CLI Flag                                | Status                                  | Impact |
| ----------------------------------- | --------------------------------------- | --------------------------------------- | ------ |
| `folderPath` / `absDir` / `absPath` | `-f, --folder`                          | ✅                                      | —      |
| `workflowType`                      | `-w, --workflow-type`                   | ✅ honours flag, defaults to `"fsm"`    | —      |
| `skipDirs`                          | `-s, --skip-dirs`                       | ✅ passed through (directory mode only) | —      |
| `showRecommendation`                | `-r, --show-recommendation`             | ✅                                      | —      |
| Path type detection                 | (inferred from `Deno.stat` + extension) | ✅                                      | —      |

### `generate-async-logic`

Calls:
`generateAsyncOperationLogicFromFolders(folder, workflowType ?? "fsm", skipDirs)`

| Parameter      | CLI Flag              | Status                               | Impact |
| -------------- | --------------------- | ------------------------------------ | ------ |
| `folderPath`   | `-f, --folder`        | ✅                                   | —      |
| `workflowType` | `-w, --workflow-type` | ✅ honours flag, defaults to `"fsm"` | —      |
| `skipDirs`     | `-s, --skip-dirs`     | ✅ parsed and passed through         | —      |

### `generate-sync-logic`

Calls:
`generateSyncOperationLogicFromFolders(folder, workflowType ?? "fsm", langs, skipDirs)`

| Parameter      | CLI Flag              | Status                                 | Impact |
| -------------- | --------------------- | -------------------------------------- | ------ |
| `folderPath`   | `-f, --folder`        | ✅                                     | —      |
| `workflowType` | `-w, --workflow-type` | ✅ honours flag, defaults to `"fsm"`   | —      |
| `langs`        | `-l, --lang`          | ✅ validated; defaults to `typescript` | —      |
| `skipDirs`     | `-s, --skip-dirs`     | ✅ parsed and passed through           | —      |

### `delete`

Calls: `deleteFsmJSONFromFolders(folder, workflowType ?? "fsm", skipDirs)`

| Parameter      | CLI Flag              | Status                               | Impact |
| -------------- | --------------------- | ------------------------------------ | ------ |
| `folderPath`   | `-f, --folder`        | ✅                                   | —      |
| `workflowType` | `-w, --workflow-type` | ✅ honours flag, defaults to `"fsm"` | —      |
| `skipDirs`     | `-s, --skip-dirs`     | ✅ parsed and passed through         | —      |

### `validate-sync-operation`

Calls:
`validateSyncOperationFromFolders(folder, workflowType, skipDirs, availableActors)`

| Parameter         | CLI Flag                 | Status                                               | Impact |
| ----------------- | ------------------------ | ---------------------------------------------------- | ------ |
| `folderPath`      | `-f, --folder`           | ✅                                                   | —      |
| `workflowType`    | `-w, --workflow-type`    | ✅                                                   | —      |
| `skipDirs`        | `-s, --skip-dirs`        | ✅ parsed and passed through                         | —      |
| `availableActors` | `-a, --available-actors` | ✅ loaded from JSON file via `loadAvailableActors()` | —      |

### `validate-async-operation`

Calls:
`validateAsyncOperationFromFoldersV2(folder, workflowType, skipDirs, availableActors, validateLangs)`

| Parameter         | CLI Flag                 | Status                                                  | Impact |
| ----------------- | ------------------------ | ------------------------------------------------------- | ------ |
| `folderPath`      | `-f, --folder`           | ✅                                                      | —      |
| `workflowType`    | `-w, --workflow-type`    | ✅                                                      | —      |
| `skipDirs`        | `-s, --skip-dirs`        | ✅ parsed and passed through                            | —      |
| `availableActors` | `-a, --available-actors` | ✅ loaded from JSON file via `loadAvailableActors()`    | —      |
| `validateLangs`   | `-l, --lang`             | ✅ comma-separated; empty (omitted) means all languages | —      |

### `load`

Calls: `loadFsmJSONFromFolders(folder, workflowType, skipDirs, deps)`

| Parameter      | CLI Flag                         | Status                                                                                            | Impact |
| -------------- | -------------------------------- | ------------------------------------------------------------------------------------------------- | ------ |
| `folderPath`   | `-f, --folder`                   | ✅                                                                                                | —      |
| `workflowType` | `-w, --workflow-type`            | ✅                                                                                                | —      |
| `skipDirs`     | `-s, --skip-dirs`                | ✅ parsed and passed through                                                                      | —      |
| `deps`         | `-d, --db-url` or `DATABASE_URL` | ✅ `buildDeps()` prefers `--db-url`, falls back to env var, exits with clear error if neither set | —      |

`load` is shared by every workflow type — there is no separate load command per
sync/async operation logic. `validate-sync-operation-and-load` and
`validate-async-operation-and-load` (which used to combine validation with a DB
write) were removed; validate with the commands above, then run `load` as a
separate step.

---

## 2. Exported Functions with No CLI Command

| Exported Function                     | CLI Command                            | Note                                                              |
| ------------------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| `validateSyncOperationFromFolders`    | `validate-sync-operation`              | ✅                                                                |
| `validateAsyncOperationFromFoldersV2` | `validate-async-operation`             | ✅                                                                |
| `generateFsmJSONFromMachineFile`      | `generate` (when `-f` is a `.ts` file) | ✅                                                                |
| `addMissingFsmTypeToInvokeActors`     | _(none)_                               | Intentional — internal transform, library-only                    |
| `normalizeActionsToObjects`           | _(none)_                               | Intentional — internal transform, library-only                    |
| `addActionNameFromDelay`              | _(none)_                               | Intentional — internal transform, library-only                    |
| `validateSyncOperationFromFolder`     | _(none)_                               | Intentional — single-folder variant called by the folders variant |
| `validateLanguageModules`             | _(none)_                               | Intentional — called internally by validate functions             |
| `isFunction`, `hasArity`              | _(none)_                               | Intentional — utility predicates                                  |

---

## 3. Input Validation Gaps

| Gap                                                | Location                 | Status                                                                                      | Severity |
| -------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------- | -------- |
| `--workflow-type` accepts any string               | startup                  | ✅ Fixed — validated against `VALID_WORKFLOW_TYPES` at startup, exits with error            | High     |
| No check that `--folder` path exists               | after missing-args block | ✅ Fixed — `Deno.stat(folder)` check exits with a clear error if missing or not a directory | Medium   |
| No early check for DB connection string            | `buildDeps()`            | ✅ Fixed — exits with a clear error message if neither `--db-url` nor `DATABASE_URL` is set | High     |
| `--folder` rejected non-directories for `generate` | stat check block         | ✅ Fixed — `isDirectory` assertion skipped when `command === "generate"`                    | Medium   |

---

## 4. Help Text Gaps

Location: `printHelp()` in `src/cli/index.ts`.

| Issue                                                    | Status                                                                                                         |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `--skip-dirs` flag missing from help and CLI             | ✅ Fixed — flag exists, documented in help, passed to all commands                                             |
| `--available-actors` flag missing from help and CLI      | ✅ Fixed — flag exists, documented in help, passed to `validate-sync-operation` and `validate-async-operation` |
| `DATABASE_URL` env var not mentioned for DB commands     | ✅ Fixed — documented under `ENVIRONMENT` in help text                                                         |
| `--show-recommendation` not scoped to `generate` in help | ✅ Fixed — help text notes it applies to `generate` only                                                       |
| `-w` description scoping for scaffold/delete commands    | ✅ Fixed — help says "optional for generate, generate-async-logic, generate-sync-logic, delete"                |

---

## 5. Test Coverage Gaps

Test files: `test/cli.test.ts`, `src/cli/index-test.ts`.

| Command / Scenario                           | Tested?             |
| -------------------------------------------- | ------------------- |
| `--help` / `-h`                              | ✅                  |
| no args → help                               | ✅                  |
| `generate` (success)                         | ✅                  |
| `generate --show-recommendation` / `-r`      | ✅                  |
| `generate-async-logic`                       | ✅                  |
| `generate-sync-logic` (+ invalid `--lang`)   | ✅                  |
| `delete`                                     | ✅                  |
| `validate-sync-operation` (success)          | ✅                  |
| `validate-sync-operation -w` shorthand       | ✅                  |
| `validate-async-operation`                   | ✅                  |
| Invalid `--workflow-type` value              | ✅                  |
| `--folder` path that does not exist          | ✅                  |
| Missing DB connection string for DB commands | ✅                  |
| `--db-url` flag accepted and parsed          | ✅                  |
| `--skip-dirs` flag                           | ✅                  |
| `--available-actors` flag                    | ✅                  |
| `generate` with `.ts` file path              | ❌ (not yet tested) |
| `generate` with `.json` file path            | ❌ (not yet tested) |
| `load` (real DB)                             | ❌ (needs DB)       |
