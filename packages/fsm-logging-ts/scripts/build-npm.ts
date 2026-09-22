import { build, emptyDir } from "@deno/dnt";

await emptyDir("./dist");

const packageVersion = Deno.args[0]?.replace(/^v/, "") ?? "0.0.0";

await build({
  entryPoints: ["./src/index.ts"],
  outDir: "./dist",
  shims: {
    deno: true,
  },
  package: {
    name: "@pgfsm/logging",
    version: packageVersion,
    description:
      "Shared LogTape logging configuration (composition-root configurator, category vocabulary, table-rendering console sink) for FSM services",
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
