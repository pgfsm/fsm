import { assertEquals } from "@std/assert";
import { findMergedImportMap } from "../src/cli/loader.node.ts";

// findMergedImportMap only reads/parses config files off disk (node:fs) —
// it never dynamically imports anything, so unlike test-helpers.ts's
// makeWorkspaceTempDir() these fixtures don't need to live under this
// package's own tree; a plain OS temp dir is fine.
async function makeFixtureDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "pgfsm-import-resolution-test-" });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Deno.writeTextFile(path, JSON.stringify(value));
}

Deno.test("findMergedImportMap - standalone config with no workspace", async () => {
  const dir = await makeFixtureDir();
  await writeJson(`${dir}/deno.json`, {
    imports: { xstate: "npm:xstate@^5.28.0" },
  });

  const map = await findMergedImportMap(dir);
  assertEquals(map, { xstate: "npm:xstate@^5.28.0" });
});

Deno.test("findMergedImportMap - nearest member config wins over workspace root for the same key", async () => {
  const root = await makeFixtureDir();
  await writeJson(`${root}/deno.json`, {
    workspace: ["member"],
    imports: { xstate: "npm:xstate@^5.0.0", shared: "npm:shared@^1.0.0" },
  });
  await Deno.mkdir(`${root}/member`, { recursive: true });
  await writeJson(`${root}/member/deno.json`, {
    imports: { xstate: "npm:xstate@^5.28.0" },
  });

  const map = await findMergedImportMap(`${root}/member`);
  assertEquals(map, {
    xstate: "npm:xstate@^5.28.0",
    shared: "npm:shared@^1.0.0",
  });
});

Deno.test("findMergedImportMap - resolution starts below the member config and still finds the root", async () => {
  const root = await makeFixtureDir();
  await writeJson(`${root}/deno.json`, {
    workspace: ["member"],
    imports: { shared: "npm:shared@^1.0.0" },
  });
  await Deno.mkdir(`${root}/member/fsm/creditCheck/v01`, { recursive: true });
  await writeJson(`${root}/member/deno.json`, {
    imports: { xstate: "npm:xstate@^5.28.0" },
  });

  const map = await findMergedImportMap(`${root}/member/fsm/creditCheck/v01`);
  assertEquals(map, {
    xstate: "npm:xstate@^5.28.0",
    shared: "npm:shared@^1.0.0",
  });
});

Deno.test("findMergedImportMap - no deno.json anywhere in the ancestry returns an empty map", async () => {
  const dir = await makeFixtureDir();
  const map = await findMergedImportMap(dir);
  assertEquals(map, {});
});

Deno.test("findMergedImportMap - deno.jsonc (with comments) is found and parsed", async () => {
  const dir = await makeFixtureDir();
  await Deno.writeTextFile(
    `${dir}/deno.jsonc`,
    `{
      // a line comment
      "imports": {
        "xstate": "npm:xstate@^5.28.0" /* trailing block comment */
      }
    }`,
  );

  const map = await findMergedImportMap(dir);
  assertEquals(map, { xstate: "npm:xstate@^5.28.0" });
});

Deno.test("findMergedImportMap - a config declaring its own workspace stops the walk there", async () => {
  const dir = await makeFixtureDir();
  await writeJson(`${dir}/deno.json`, {
    workspace: ["member"],
    imports: { xstate: "npm:xstate@^5.28.0" },
  });

  const map = await findMergedImportMap(dir);
  assertEquals(map, { xstate: "npm:xstate@^5.28.0" });
});
