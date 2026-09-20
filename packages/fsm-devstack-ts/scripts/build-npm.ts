import { build, emptyDir } from "@deno/dnt";

await emptyDir("./dist");

// Library entry point only — `fsmdev` itself (src/cli/fsmdev.ts) still shells
// out to sibling CLIs via `Deno.Command(Deno.execPath(), ["run", ...])`,
// which isn't portable to a Node/npm install. Registering it as a `bin` here
// is tracked separately (see CLAUDE.md's npm-publish note).
await build({
  entryPoints: ["./src/index.ts"],
  outDir: "./dist",
  shims: {
    deno: true,
  },
  // This package colocates supervisor.test.ts under src/ (the other dnt-built
  // packages' test files live outside src/) — without this, dnt also
  // transforms/type-checks it as a Node test file, pulling in @std/assert,
  // which needs a newer target lib than compilerOptions below sets.
  test: false,
  package: {
    name: "@pgfsm/devstack",
    version: Deno.args[0]?.replace(/^v/, "") ?? "0.0.0",
    description:
      "Process spawn/signal supervision primitive backing the fsmdev local FSM dev-stack CLI",
    license: "Apache-2.0",
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
