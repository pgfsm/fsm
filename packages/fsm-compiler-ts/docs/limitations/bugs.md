# fsm-compiler-ts — Potential Bugs

Source files audited: `src/generate-fsm-json.ts`,
`src/generate-async-operation-logic.ts`, `src/generate-sync-operation-logic.ts`,
`src/operation-logic-scaffold.ts`, `src/delete-fsm-json-from-folders.ts`,
`src/load-fsm-json.ts`, `src/validate-and-load-fsm.ts`,
`src/validate-fsm-plugin-load.ts`, `src/util.ts`, `src/cli/index.ts`.

---

## Bug #1 — Medium | `generateFsmJSON.ts:157` ✅ Fixed

**Missing null-safety on `t.eventType`**

`t.eventType` was spread unconditionally. If an after-transition has a `delay`
but no `eventType`, `delayActionEventType` was silently set to `undefined`.

**Fixed:**

```ts
return {
  ...a,
  delayActionName: DELAY_ACTION_NAME_PREFIX + t.delay,
  ...(t.eventType !== undefined && { delayActionEventType: t.eventType }),
};
```

---

## Bug #2 — High | `loadFsmJSON.ts` ✅ Fixed

**`folderResults` collected but never returned**

`folderResults` was declared inside the outer `for await` loop (reset on each
FSM directory iteration) and the function had no return statement — callers
always received `undefined`.

**Fixed:** Moved `const folderResults: any[] = []` outside both loops, added
`return folderResults`, and updated the return type to `Promise<any[]>`.

---

## Bug #3 — High | `validateFsmPluginLoad.ts` ✅ Fixed

**Dynamic `import()` without `file://` prefix in `validateLanguageModules`**

Bare filesystem paths in `import()` can throw on certain systems/Deno versions.

**Fixed:** `await import(\`file://${modulePath}\`)`

---

## Bug #4 — High | `validateFsmPluginLoad.ts` ✅ Fixed

**Same `file://` issue in `validatePromisePluginLoadFromFolder`**

Identical to Bug #3 in a different function.

**Fixed:** `await import(\`file://${modulePath}\`)`

---

## Bug #5 — Medium | `src/util.ts` ✅ Fixed

**`InternalActor` type missing `resolved` property**

`InternalActor` did not include `resolved: boolean`, but
`validateFsmPluginLoadFromFolder` assigns `resolved: true` to internal actors at
runtime. The field was invisible to any consumer typing its input as
`InternalActor[]`.

**Fixed:** Added `resolved: boolean` to `InternalActor` in `util.ts`:

```ts
export type InternalActor = {
  src: string;
  fsmName: string;
  fsmType?: string;
  fsmVersion?: string;
  fsmAbsFolderPath: string;
  fsmRelativeFolderPath: string;
  resolved: boolean;
};
```

---

## Bug #6 — Medium | `loadAndValidateFsm.ts:171` ✅ Fixed

**Unsafe spread of potentially `undefined` `fsmResult`**

`(fsmResult as object)` suppressed the TS error but at runtime
`{ ...undefined }` evaluates to `{}` — silently dropping DB results.

**Fixed:**

```ts
allFolderResults.push({
  ...folderResult,
  ...(fsmResult != null && typeof fsmResult === "object" ? fsmResult : {}),
});
```

---

## Bug #7 — Low | `loadFsmJSON.ts:26` ✅ Fixed

**Dead variable `rootNodeText`**

`rootNodeText` was always `null` and added no information.

**Fixed:** Pass `null` inline and remove the dead variable:

```ts
const fsmResult = await loadFsmFromJson(
  deps,
  fsmData,
  null,
  workflowType,
  fsmName,
  fsmVersion,
);
```

---

## Bug #8 — Low | `operation-logic-scaffold.ts` (`writeActorFile`) ✅ Resolved

**Actor deduplication by `src` only — different `fsmType`/`fsmVersion` collapse
silently**

Previously all actors were written into a single `actors/index` module and
deduplicated by `src`, so two actors sharing a `src` but differing in
`fsmType`/`fsmVersion` collapsed into one stub. `generate-async-logic` now
writes **one file per invoke** at
`<lang>/actors/<fsmType>_<fsmVersion>_<src>.<ext>` and deduplicates by the full
`<fsmType>_<fsmVersion>_<src>` — distinct type/version combinations no longer
collapse.

---

## Bug #9 — Medium | `src/cli/index.ts:134–140` ✅ Fixed

**`workflowType` hardcoded as `"fsm"` for the scaffold/generate/delete
commands**

Previously the `-w / --workflow-type` flag was ignored for these commands. Fixed
by using `workflowType ?? "fsm"`:

```ts
case "generate":
  await generateFsmJSONFromFolders(folder!, workflowType ?? "fsm", skipDirs, args["show-recommendation"]);
  break;
case "generate-async-logic":
  await generateAsyncOperationLogicFromFolders(folder!, workflowType ?? "fsm", skipDirs);
  break;
case "generate-sync-logic":
  await generateSyncOperationLogicFromFolders(folder!, workflowType ?? "fsm", langs, skipDirs);
  break;
case "delete":
  await deleteFsmJSONFromFolders(folder!, workflowType ?? "fsm", skipDirs);
  break;
```

---

## Bug #10 — Low | `src/cli/index.ts:118–129` ✅ Fixed

**No early validation of DB connection string for DB-dependent commands**

Previously `buildDeps()` created a `pg.Pool` with `undefined` as the connection
string when `DATABASE_URL` was absent, and the error only surfaced on the first
query. Fixed by adding `--db-url` CLI flag support and early validation in
`buildDeps()`:

```ts
async function buildDeps(connectionString?: string) {
  const dbUrl = connectionString ?? (() => {
    dotenv.config({ path: ".env" });
    return Deno.env.get("DATABASE_URL");
  })();
  if (!dbUrl) {
    console.error(
      "Error: No database connection string provided. Use --db-url <url> or set DATABASE_URL in .env",
    );
    Deno.exit(1);
  }
  const { Pool } = await import("pg");
  return { db: new Pool({ connectionString: dbUrl }) };
}
```

---

## Bug #11 — Medium | `loadAndValidateFsm.ts:6` ✅ Fixed

**Schema version mismatch between `load-and-validate` and
`validate-sync-operation`**

`loadAndValidateFsm.ts` was validating against `fsm.machine.schema.v1.json`
while `validateFsmPluginLoad.ts` used `fsm.machine.schema.v2.json`, causing
silent inconsistencies between the two commands.

**Fixed:** Updated `loadAndValidateFsm.ts` line 6:

```ts
import machineSchema from "../../database-src/fsm.machine.schema.v2.json" with {
  type: "json",
};
```

---

## Bug #12 — Medium | `validateFsmPluginLoad.ts:322`

**`dependency.fsmType` is `string | undefined` but `FailedMethod.moduleType`
expects `string`**

When pushing a missing-dependency entry to `failedMethods`, `dependency.fsmType`
was passed directly as `moduleType`. Since `fsmType` is optional on
`ActorReference`, this is a type mismatch.

**Fixed:** `moduleType: dependency.fsmType ?? "unknown"`
