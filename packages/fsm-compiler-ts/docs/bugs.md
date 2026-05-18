# fsm-compiler-ts — Potential Bugs

Source files audited: `src/generateFsmJSON.ts`, `src/generateFsmPlugin.ts`, `src/cleanFsmJSON.ts`, `src/loadFsmJSON.ts`, `src/loadAndVerifyFsm.ts`, `src/validateFsmPluginLoad.ts`, `src/util.ts`, `src/cli/index.ts`.

---

## Bug #1 — Medium | `generateFsmJSON.ts:157`

**Missing null-safety on `t.eventType`**

```ts
return { ...a, delayActionName: DELAY_ACTION_NAME_PREFIX + t.delay, delayActionEventType: t.eventType };
```

`t.eventType` is spread unconditionally. If an after-transition has a `delay` but no `eventType`, `delayActionEventType` is silently set to `undefined`, producing invalid metadata in the generated `fsm.json`.

**Suggested fix:**
```ts
return {
  ...a,
  delayActionName: DELAY_ACTION_NAME_PREFIX + t.delay,
  ...(t.eventType !== undefined && { delayActionEventType: t.eventType }),
};
```

---

## Bug #2 — High | `loadFsmJSON.ts:73-85`

**`folderResults` collected but never returned**

```ts
const folderResults = [];
for await (const subEntry of Deno.readDir(fsmDirPath)) {
  // ...
  const folderResult = await loadFsmJSONFromFolder(...);
  folderResults.push(folderResult);   // pushed but the outer function has no return
}
```

`loadFsmJSONFromFolders` has no `return` statement — callers always receive `undefined`. Any code that depends on the result of a bulk load silently gets nothing.

**Suggested fix:** Add `return folderResults;` after the outer `for await` loop (line ~89), and update the function return type from `Promise<void>` to `Promise<(unknown)[]>`.

---

## Bug #3 — High | `validateFsmPluginLoad.ts:56`

**Dynamic `import()` without `file://` prefix**

```ts
const mod = await import(modulePath);   // modulePath is an absolute filesystem path
```

In `validateLanguageModules`, `modulePath` is an absolute path like `/home/user/project/...`. On some systems (especially Windows and certain Deno versions) a bare filesystem path in `import()` throws. The pattern used elsewhere in the codebase (e.g., `generateFsmJSON.ts:262`) consistently uses `file://`.

**Suggested fix:**
```ts
const mod = await import(`file://${modulePath}`);
```

---

## Bug #4 — High | `validateFsmPluginLoad.ts:115`

**Same `file://` issue in `validatePromisePluginLoadFromFolder`**

```ts
const mod = await import(modulePath);
```

Identical problem to Bug #3 in a different function.

**Suggested fix:**
```ts
const mod = await import(`file://${modulePath}`);
```

---

## Bug #5 — Medium | `validateFsmPluginLoad.ts:249, 290`

**`internalActors` type missing `resolved` property**

`internalActors` is declared at line 249 as:
```ts
let internalActors: { src: string; fsmName: string; fsmType: string; fsmVersion: string; fsmAbsFolderPath: string; fsmRelativeFolderPath: string }[] = [];
```

But at line 290 it is assigned objects that also include `resolved: true`:
```ts
internalActors = actors.filter(actor => actor.fsmType === 'promise')
  .map(actor => ({ ...actor, resolved: true, fsmName: actor.src, ... }));
```

The `resolved` field is not in the declared type. TypeScript infers a type mismatch and the property is invisible to consumers of `internalActors`.

**Suggested fix:** Add `resolved: boolean` to the `internalActors` type declaration.

---

## Bug #6 — Medium | `loadAndVerifyFsm.ts:171`

**Unsafe spread of potentially `undefined` `fsmResult`**

```ts
allFolderResults.push({ ...folderResult, ...(fsmResult as object) });
```

`fsmResult` comes from `loadFsmFromJson(...)` which can return `undefined` (the function has code paths with no return value). Spreading `undefined` as `object` via `as object` suppresses the TS error but at runtime `{ ...undefined }` evaluates to `{}` — silently dropping all DB results from the accumulated output.

**Suggested fix:**
```ts
allFolderResults.push({
  ...folderResult,
  ...(fsmResult != null && typeof fsmResult === 'object' ? fsmResult : {}),
});
```

---

## Bug #7 — Low | `loadFsmJSON.ts:26`

**Dead variable `rootNodeText`**

```ts
const rootNodeText = null;
const fsmResult = await loadFsmFromJson(deps, fsmData, rootNodeText, workflow_type, fsmName, fsmVersion);
```

`rootNodeText` is always `null` and is never passed differently based on any condition. If the underlying `loadFsmFromJson` function ever needs a real root node, this parameter is silently wrong. Either make it a configurable parameter of `loadFsmJSONFromFolder`, or remove the variable and pass `null` inline.

---

## Bug #8 — Low | `generateFsmPlugin.ts:14`

**Actor deduplication by `src` only — different `fsmType`/`fsmVersion` collapse silently**

```ts
const actorNames = [...new Set(actors.map(a => a.src))];
```

If two actors share the same `src` string but differ in `fsmType` or `fsmVersion`, they are collapsed into one stub. This could generate an incorrect or incomplete plugin file when multiple versions of the same actor are involved.

**Suggested fix:** Deduplicate on a composite key `${a.src}:${a.fsmType}:${a.fsmVersion}`, or document that multi-version actors are intentionally collapsed.

---

## Bug #9 — Medium | `src/cli/index.ts:92, 95, 98` ✅ Fixed (as CLI gap)

**`workflow_type` hardcoded as `"fsm"` for `generate`, `generate-plugin`, `clean`**

```ts
case "generate":
  await generateFsmJSONFromFolders(folder!, "fsm", [], args["show-recommendation"]);
case "generate-plugin":
  await generateFsmPluginFromFolders(folder!, "fsm");
case "clean":
  await deleteFsmJSONFromFolders(folder!, "fsm");
```

The `-w / --workflow-type` flag is ignored for these three commands even though the user can provide it. Passing a `sharedFsm` or `sharedPromise` folder to `generate` will produce incorrect results because the hardcoded `"fsm"` type is passed to the underlying function.

**Suggested fix:** Use `workflowType ?? "fsm"` so the flag is honoured when provided.

---

## Bug #10 — Low | `src/cli/index.ts:103-116` ✅ Fixed (as CLI gap)

**No early validation of `DATABASE_URL` for DB-dependent commands**

```ts
case "load": {
  const deps = await buildDeps();   // silently creates a Pool with undefined connectionString
  await loadFsmJSONFromFolders(folder!, workflowType!, [], deps);
```

`buildDeps()` calls `dotenv.config()` then creates a `pg.Pool` with `Deno.env.get("DATABASE_URL")`. If the env var is missing, `Pool` is created with `undefined` as the connection string, and the error only surfaces when the first query runs — mid-execution, with a confusing message.

**Suggested fix:** Check for `DATABASE_URL` immediately after `dotenv.config()` and exit with a clear message if it is absent.
