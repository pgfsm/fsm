// scripts/check-licenses.ts (#709): passes on the repository, and catches each
// kind of drift on a small fixture repository.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  check,
  globToRegExp,
  importSpecifiers,
  licenseOf,
  parseAnnotations,
} from "./check-licenses.ts";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const APACHE = await Deno.readTextFile(`${REPO}/LICENSES/Apache-2.0.txt`);
const AGPL = await Deno.readTextFile(`${REPO}/LICENSES/AGPL-3.0-only.txt`);

const REUSE = `version = 1
[[annotations]]
path = "**"
SPDX-License-Identifier = "Apache-2.0"
[[annotations]]
path = ["packages/engine/**"]
SPDX-License-Identifier = "AGPL-3.0-only"
[[annotations]]
path = ["packages/engine/contract/**"]
SPDX-License-Identifier = "Apache-2.0"
`;

/** Writes `files` (path → content) under a fresh temporary root. */
async function fixture(files: Record<string, string>): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "check-licenses-" });
  for (const [path, content] of Object.entries(files)) {
    const dir = path.split("/").slice(0, -1).join("/");
    if (dir) await Deno.mkdir(`${root}/${dir}`, { recursive: true });
    await Deno.writeTextFile(`${root}/${path}`, content);
  }
  return root;
}

/** A fixture that satisfies every rule; tests break one rule each. */
function goodFiles(): Record<string, string> {
  return {
    "REUSE.toml": REUSE,
    "packages/engine/LICENSE": AGPL,
    "packages/engine/deno.json": JSON.stringify({
      name: "@acme/engine",
      license: "AGPL-3.0-only",
    }),
    "packages/engine/src/index.ts": `import { x } from "./lib.ts";\n`,
    "packages/engine/contract/schema.ts": `export type T = string;\n`,
    "packages/sdk/LICENSE": APACHE,
    "packages/sdk/deno.json": JSON.stringify({
      name: "@acme/sdk",
      license: "Apache-2.0",
    }),
    "packages/sdk/scripts/build-npm.ts":
      `await build({ package: { license: "Apache-2.0" } });\n`,
    "packages/sdk/src/index.ts": [
      `import type { T } from "../../engine/contract/schema.ts";`,
      `// import { y } from "@acme/engine"; (a comment, not an import)`,
      `export const t: T = "";`,
    ].join("\n"),
    "packages/sdk/test/engine.test.ts": `import { e } from "@acme/engine";\n`,
  };
}

Deno.test("the repository passes", async () => {
  assertEquals(await check(REPO), []);
});

Deno.test("a fixture that follows every rule passes", async () => {
  assertEquals(await check(await fixture(goodFiles())), []);
});

Deno.test("an MIT manifest under an Apache-2.0 path fails", async () => {
  const files = goodFiles();
  files["packages/sdk/deno.json"] = JSON.stringify({
    name: "@acme/sdk",
    license: "MIT",
  });
  assertEquals(await check(await fixture(files)), [
    "packages/sdk/deno.json: declares MIT, but REUSE.toml says Apache-2.0",
  ]);
});

Deno.test("a build-npm.ts licence that drifts fails", async () => {
  const files = goodFiles();
  files["packages/sdk/scripts/build-npm.ts"] =
    `await build({ package: { license: "AGPL-3.0-only" } });\n`;
  assertEquals(await check(await fixture(files)), [
    "packages/sdk/scripts/build-npm.ts: declares AGPL-3.0-only, but REUSE.toml says Apache-2.0",
  ]);
});

Deno.test("a LICENSE file with the wrong text, or none, fails", async () => {
  const wrong = goodFiles();
  wrong["packages/engine/LICENSE"] = APACHE;
  assertEquals(await check(await fixture(wrong)), [
    "packages/engine/LICENSE: holds Apache-2.0, but REUSE.toml says AGPL-3.0-only",
  ]);
  const missing = goodFiles();
  delete missing["packages/sdk/LICENSE"];
  assertEquals(await check(await fixture(missing)), [
    "packages/sdk: no LICENSE file in it or its package folder",
  ]);
});

Deno.test("shipped Apache-2.0 code importing AGPL code fails; tests don't count", async () => {
  const files = goodFiles();
  files["packages/sdk/src/bad.ts"] = [
    `import { a } from "../../engine/src/index.ts";`,
    `import { b } from "@acme/engine";`,
    `const c = await import("npm:@acme/engine@1");`,
  ].join("\n");
  assertEquals(await check(await fixture(files)), [
    "packages/sdk/src/bad.ts: Apache-2.0 code imports AGPL-3.0-only packages/engine/src/index.ts",
    "packages/sdk/src/bad.ts: Apache-2.0 code imports AGPL-3.0-only package @acme/engine",
    "packages/sdk/src/bad.ts: Apache-2.0 code imports AGPL-3.0-only package npm:@acme/engine@1",
  ]);
});

Deno.test("the last matching annotation wins, as in reuse", () => {
  const annotations = parseAnnotations(REUSE);
  assertEquals(licenseOf("README.md", annotations), "Apache-2.0");
  assertEquals(
    licenseOf("packages/engine/src/a.ts", annotations),
    "AGPL-3.0-only",
  );
  assertEquals(
    licenseOf("packages/engine/contract/x.ts", annotations),
    "Apache-2.0",
  );
});

Deno.test("globs: ** crosses directories, * doesn't", () => {
  assert(globToRegExp("packages/a/**").test("packages/a/b/c.ts"));
  assert(globToRegExp("packages/a/*.json").test("packages/a/x.json"));
  assert(!globToRegExp("packages/a/*.json").test("packages/a/b/x.json"));
});

Deno.test("importSpecifiers reads multi-line imports and skips comments", () => {
  assertEquals(
    importSpecifiers(
      `import {\n  a,\n  b,\n} from "./a.ts";\n/* import x from "./no.ts"; */\nexport * from "./b.ts";\nimport "./side.ts";\n`,
    ),
    ["./a.ts", "./b.ts", "./side.ts"],
  );
});
