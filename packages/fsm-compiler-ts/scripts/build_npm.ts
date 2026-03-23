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
  package: {
    name: "@fsm/compiler",
    version: Deno.args[0]?.replace(/^v/, "") ?? "0.0.0",
    description: "FSM JSON compiler for PostgreSQL-backed state machines",
    license: "MIT",
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
