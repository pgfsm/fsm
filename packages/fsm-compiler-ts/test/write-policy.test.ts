import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs/copy";
import { generateAll } from "../src/generate-all.ts";
import {
  type FileWriteEvent,
  withWritePolicy,
  writeOwnedFile,
} from "../src/write-policy.ts";
import { makeWorkspaceTempDir } from "./test-helpers.ts";

// #381: overwrite "generated-only" keeps existing scaffolded files (the
// developer's code) and always rewrites generated ones; "all" (default) keeps
// the compiler's historical rewrite-everything behaviour.
const FIXTURE_ROOT = await makeWorkspaceTempDir("write-policy");
const APP_ROOT = `${FIXTURE_ROOT}/fsm-core-example`;
await copy("apps/fsm-core-example", APP_ROOT);
const SINGLE_FSM_JSON = `${APP_ROOT}/fsm/creditCheck/v01/fsm.json`;

// --- writeOwnedFile ---

Deno.test("writeOwnedFile - default mode rewrites an existing scaffolded file", async () => {
  const file = `${FIXTURE_ROOT}/unit-default.ts`;
  await Deno.writeTextFile(file, "mine\n");
  const action = await writeOwnedFile(file, "new\n", "scaffolded");
  assertEquals(action, "regenerated");
  assertEquals(await Deno.readTextFile(file), "new\n");
});

Deno.test("writeOwnedFile - generated-only keeps an existing scaffolded file, rewrites a generated one, and creates missing ones", async () => {
  const events: FileWriteEvent[] = [];
  const scaffolded = `${FIXTURE_ROOT}/unit-scaffolded.ts`;
  const generated = `${FIXTURE_ROOT}/unit-generated.ts`;
  const fresh = `${FIXTURE_ROOT}/unit-fresh.ts`;
  await Deno.writeTextFile(scaffolded, "mine\n");
  await Deno.writeTextFile(generated, "stale\n");

  await withWritePolicy(
    { overwrite: "generated-only", onFileWrite: (e) => events.push(e) },
    async () => {
      assertEquals(
        await writeOwnedFile(scaffolded, "new\n", "scaffolded"),
        "kept",
      );
      assertEquals(
        await writeOwnedFile(generated, "new\n", "generated"),
        "regenerated",
      );
      assertEquals(
        await writeOwnedFile(fresh, "new\n", "scaffolded"),
        "created",
      );
    },
  );

  assertEquals(await Deno.readTextFile(scaffolded), "mine\n");
  assertEquals(await Deno.readTextFile(generated), "new\n");
  assertEquals(await Deno.readTextFile(fresh), "new\n");
  assertEquals(events.map((e) => e.action), ["kept", "regenerated", "created"]);
});

Deno.test("writeOwnedFile - a kept file reports required names it doesn't define", async () => {
  const events: FileWriteEvent[] = [];
  const file = `${FIXTURE_ROOT}/unit-missing.ts`;
  await Deno.writeTextFile(
    file,
    "export function approve() {}\nexport function approveLater() {}\n",
  );
  await withWritePolicy(
    { overwrite: "generated-only", onFileWrite: (e) => events.push(e) },
    () =>
      writeOwnedFile(file, "ignored", "scaffolded", [
        "approve",
        "reject",
        "approveLater",
      ]),
  );
  // "approve" is matched as a whole identifier, not as a prefix of
  // "approveLater" -- only "reject" is missing.
  assertEquals(events[0].missingNames, ["reject"]);
});

Deno.test("withWritePolicy - a nested scope inherits options it leaves undefined", async () => {
  const events: FileWriteEvent[] = [];
  const file = `${FIXTURE_ROOT}/unit-nested.ts`;
  await Deno.writeTextFile(file, "mine\n");
  await withWritePolicy(
    { overwrite: "generated-only", onFileWrite: (e) => events.push(e) },
    () =>
      withWritePolicy(
        undefined,
        () => writeOwnedFile(file, "new\n", "scaffolded"),
      ),
  );
  assertEquals(await Deno.readTextFile(file), "mine\n");
  assertEquals(events.length, 1);
});

// --- generateAll end to end ---

Deno.test("generateAll overwrite generated-only - a re-run keeps edited stubs/entry files/deno.json byte-for-byte and rewrites generated files", async () => {
  const root = `${FIXTURE_ROOT}/e2e`;
  const opts = {
    folder: SINGLE_FSM_JSON,
    writeRootAbsPath: root,
    fsmName: "creditCheck",
    fsmVersion: "v01",
    overwrite: "generated-only" as const,
  };
  await generateAll(opts);

  const sync = `${root}/sync-worker/typescript`;
  const actions = `${sync}/creditCheck/v01/actions/index.ts`;
  const runSync = `${sync}/run-sync-worker.ts`;
  const syncDenoJson = `${sync}/deno.json`;
  const actor =
    `${root}/async-worker/typescript/creditCheck/v01/actors/verifyCredentials/verifyCredentials.ts`;
  const syncRegistry =
    `${sync}/creditCheck/v01/generated-sync-operation-registry.ts`;
  const aggregate =
    `${root}/async-worker/typescript/typescript-actors-registry.generated.ts`;

  // Deliberately unformatted edits: a deno fmt pass over them would change
  // them, so byte-equality also proves the formatter skipped kept files.
  const edits: Record<string, string> = {
    [actions]: (await Deno.readTextFile(actions)) +
      "export   const  myHelper=1\n",
    [runSync]: "// my own entry point\nconsole.log(  'hi' )\n",
    [syncDenoJson]: '{ "name": "my-app",  "imports": {} }\n',
    [actor]: (await Deno.readTextFile(actor)) + "// implemented   by hand\n",
  };
  for (const [path, content] of Object.entries(edits)) {
    await Deno.writeTextFile(path, content);
  }
  const syncRegistryBefore = await Deno.readTextFile(syncRegistry);
  await Deno.writeTextFile(syncRegistry, "// stale\n");
  await Deno.writeTextFile(aggregate, "// stale\n");

  const events: FileWriteEvent[] = [];
  await generateAll({ ...opts, onFileWrite: (e) => events.push(e) });

  for (const [path, content] of Object.entries(edits)) {
    assertEquals(await Deno.readTextFile(path), content, path);
    assert(
      events.some((e) => e.path === path && e.action === "kept"),
      `expected a kept event for ${path}`,
    );
  }
  assertEquals(await Deno.readTextFile(syncRegistry), syncRegistryBefore);
  assertStringIncludes(await Deno.readTextFile(aggregate), "creditcheck_v01");
  assert(
    events.some((e) => e.path === syncRegistry && e.action === "regenerated"),
  );
});

Deno.test("generateAll overwrite generated-only - reports exports a kept stub module is missing", async () => {
  const root = `${FIXTURE_ROOT}/e2e-missing`;
  const opts = {
    folder: SINGLE_FSM_JSON,
    writeRootAbsPath: root,
    fsmName: "creditCheck",
    fsmVersion: "v01",
    overwrite: "generated-only" as const,
  };
  await generateAll(opts);
  const guards =
    `${root}/sync-worker/typescript/creditCheck/v01/guards/index.ts`;
  const original = await Deno.readTextFile(guards);
  const firstGuard = original.match(/export function (\w+)/)?.[1];
  assert(firstGuard, "fixture FSM should have at least one guard");
  // Simulate an FSM that gained a guard after the developer's stub was
  // written: the existing file lacks that export.
  await Deno.writeTextFile(guards, "// the developer's guards\n");

  const events: FileWriteEvent[] = [];
  await generateAll({ ...opts, onFileWrite: (e) => events.push(e) });

  const kept = events.find((e) => e.path === guards);
  assertEquals(kept?.action, "kept");
  assert(kept?.missingNames?.includes(firstGuard));
  assertEquals(await Deno.readTextFile(guards), "// the developer's guards\n");
});

Deno.test("generateAll default overwrite - a re-run still rewrites scaffolded files (unchanged behaviour)", async () => {
  const root = `${FIXTURE_ROOT}/e2e-default`;
  const opts = {
    folder: SINGLE_FSM_JSON,
    writeRootAbsPath: root,
    fsmName: "creditCheck",
    fsmVersion: "v01",
  };
  await generateAll(opts);
  const runSync = `${root}/sync-worker/typescript/run-sync-worker.ts`;
  await Deno.writeTextFile(runSync, "// mine\n");
  await generateAll(opts);
  assert((await Deno.readTextFile(runSync)) !== "// mine\n");
});

Deno.test("generateAll overwrite generated-only - folder mode keeps every language's scaffolded files and regenerates the Go worker module", async () => {
  const root = `${FIXTURE_ROOT}/e2e-polyglot`;
  const opts = {
    folder: `${APP_ROOT}/fsm`,
    writeRootAbsPath: root,
    overwrite: "generated-only" as const,
  };
  await generateAll(opts);

  const aw = `${root}/async-worker`;
  const goActorMod = await findFirst(
    `${aw}/go`,
    (p) => /\/actors\/[^/]+\/go\.mod$/.test(p),
  );
  assert(goActorMod, "fixture should produce a Go actor module");
  const scaffolded = [
    `${aw}/typescript/run-async-worker.ts`,
    `${aw}/typescript/deno.json`,
    `${aw}/python/run_async_worker.py`,
    `${aw}/python/pyproject.toml`,
    `${aw}/rust/src/main.rs`,
    `${aw}/rust/Cargo.toml`,
    `${aw}/rust/.gitignore`,
    `${aw}/go/.gitignore`,
    goActorMod,
  ];
  for (const path of scaffolded) {
    await Deno.writeTextFile(path, `# mine: ${path}\n`);
  }
  // The Go worker module lists every actor module and must match main.go's
  // SDK pin, so it's generated -- a stale copy gets rebuilt.
  await Deno.writeTextFile(`${aw}/go/go.mod`, "// stale\n");
  await Deno.writeTextFile(`${aw}/go/main.go`, "// stale\n");

  await generateAll(opts);

  for (const path of scaffolded) {
    assertEquals(await Deno.readTextFile(path), `# mine: ${path}\n`, path);
  }
  assertStringIncludes(await Deno.readTextFile(`${aw}/go/go.mod`), "require");
  assertStringIncludes(await Deno.readTextFile(`${aw}/go/main.go`), "package");
});

async function findFirst(
  dir: string,
  match: (path: string) => boolean,
): Promise<string | undefined> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isFile && match(path)) return path;
    if (entry.isDirectory) {
      const found = await findFirst(path, match);
      if (found) return found;
    }
  }
  return undefined;
}

Deno.test("cleanup fixture copy", async () => {
  await Deno.remove(FIXTURE_ROOT, { recursive: true });
});
