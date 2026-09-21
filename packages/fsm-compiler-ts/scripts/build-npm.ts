import { build, emptyDir } from "@deno/dnt";

await emptyDir("./dist");

await build({
  entryPoints: [
    "./src/index.ts",
    { kind: "bin", name: "fsm-compiler", path: "./src/cli/index.ts" },
  ],
  outDir: "./dist",
  shims: {
    deno: true,
  },
  // The CLI's help text shows how to invoke it, which differs between this
  // Deno source (`deno run ...`) and the published npm CLI (`npx ...`).
  // Runtime detection (Deno.version/mainModule/execPath) doesn't work here —
  // `shims: { deno: true }` above provides a Deno global under Node too, so
  // those signals are present (or, for execPath, actively misleading) under
  // both targets. Swap the whole module instead: see
  // src/cli/invocation.ts / invocation.node.ts.
  mappings: {
    "./src/cli/invocation.ts": "./src/cli/invocation.node.ts",
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
