import { build, emptyDir } from "@deno/dnt";

await emptyDir("./dist");

const packageVersion = Deno.args[0]?.replace(/^v/, "") ?? "0.0.0";

await build({
  entryPoints: [
    "./src/index.ts",
    { name: "./database.types", path: "./src/database.types.ts" },
  ],
  outDir: "./dist",
  shims: {
    deno: true,
  },
  // main.test.ts (deno-init scaffolding, not part of the real package — it
  // tests main.ts's placeholder `add()`, never referenced by src/index.ts)
  // imports @std/assert via a jsr: specifier. dnt's default test-transform
  // step would try to resolve that to its npm-compat scoped name
  // (@jsr/std__assert), which isn't resolvable from the default npm
  // registry without a redirect this repo doesn't configure — the same
  // failure mode fixed for @logtape/logtape in #287. Skip test transforms
  // entirely rather than dragging scaffold boilerplate into the published
  // build.
  test: false,
  package: {
    name: "@pgfsm/db",
    version: packageVersion,
    description: "Raw pg client helpers for PostgreSQL-backed FSM instances",
    license: "MIT",
    // @pgfsm/db's own public types (DBDeps.db: Pool) reference pg's Pool
    // type, but pg ships no types of its own — @types/pg supplies them.
    // dnt only auto-detects dependencies from the value-level import graph,
    // and custom.types.ts's `import type { Pool } from "pg"` is type-only,
    // so it's never auto-detected. Without this, a downstream consumer
    // without @types/pg already installed for unrelated reasons can't
    // resolve @pgfsm/db's own .d.ts output. Real dependency (not
    // devDependency) since it's needed by consumers, not just this
    // package's own build.
    dependencies: {
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
