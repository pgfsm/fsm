import { build, emptyDir } from "@deno/dnt";

await emptyDir("./dist");

// @pgfsm/db is published to npm independently (unlike @pgfsm/logging, which
// isn't in .github/workflows/npm-publish.yml's matrix and stays vendored
// below) — map it to the real npm dependency instead of letting dnt inline
// its source, so a fix published there reaches this package via semver
// instead of requiring a republish here too. Version is read from its own
// deno.json rather than hardcoded, so it can't silently drift from whatever
// this build actually resolved locally.
const dbDenoJson = JSON.parse(
  await Deno.readTextFile("../fsm-core-db-ts/deno.json"),
);
const dbVersionRange = `^${dbDenoJson.version}`;

await build({
  entryPoints: [
    "./src/index.ts",
    { kind: "bin", name: "fsm-compiler", path: "./src/cli/index.ts" },
  ],
  outDir: "./dist",
  shims: {
    deno: true,
  },
  mappings: {
    "@pgfsm/db": { name: "@pgfsm/db", version: dbVersionRange },
    "@pgfsm/db/database.types": {
      name: "@pgfsm/db",
      version: dbVersionRange,
      subPath: "database.types",
    },
  },
  // Publishing doesn't need test/*.test.ts bundled into dist — and dnt tries
  // to build them for the CJS target too, which fails on the top-level
  // await in test/cli.test.ts (CJS/UMD can't support it).
  test: false,
  package: {
    name: "@pgfsm/compiler",
    version: Deno.args[0]?.replace(/^v/, "") ?? "0.0.0",
    description: "FSM JSON compiler for PostgreSQL-backed state machines",
    license: "Apache-2.0",
    // pg ships no types of its own; dnt only auto-installs packages that
    // are themselves import specifiers, so without this the type-check
    // pass can't resolve `import ... from "pg"` (deno.json's own
    // "@types/pg" import mapping isn't picked up the same way here).
    devDependencies: {
      "@types/pg": "^8.18.0",
    },
  },
  compilerOptions: {
    lib: ["ES2022", "DOM"],
    target: "ES2022",
  },
  postBuild() {
    if (Deno.args.includes("--copy-readme")) {
      Deno.copyFileSync("README.md", "dist/README.md");
    }
  },
});
