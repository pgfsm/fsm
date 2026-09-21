import { build, emptyDir } from "@deno/dnt";

await emptyDir("./dist");

// fsmdev is registered as this package's public `bin` (its own top-level
// await is fine there — dnt only refuses top-level await when building a
// plain entry's CJS/UMD output, not a bin's). run-gateway.ts/run-fsmlet.ts
// are deliberately plain (non-bin) entries instead: fsmdev resolves and
// invokes their compiled .js siblings directly (see fsmdev.ts's `isDeno`
// branch in toProcessSpec) rather than exposing them as their own public
// commands — see packages/fsm-devstack-ts/CLAUDE.md for the full design and
// its trade-offs against registering them as bins too.
//
// NOTE: @pgfsm/compiler, @pgfsm/async-worker, and @pgfsm/sync-worker are not
// published to npm yet (only @pgfsm/db is, as of this writing) — this build
// cannot actually succeed end-to-end (its `npm install` step will 404 on
// those three) until they are. The entry points/dependency wiring below are
// written to be correct once that happens, not verified against a real
// install — see #245.
await build({
  entryPoints: [
    "./src/index.ts",
    { kind: "bin", name: "fsmdev", path: "./src/cli/fsmdev.ts" },
    "./src/cli/run-gateway.ts",
    "./src/cli/run-fsmlet.ts",
  ],
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
      "fsmdev: one-command local FSM dev stack launcher, plus the process spawn/signal supervision primitive backing it",
    license: "Apache-2.0",
    dependencies: {
      // Workspace-only specifiers, not npm: imports — dnt has no way to
      // infer these should become real npm dependencies (unlike "pg"
      // below), so they're declared explicitly, same as the @types/pg
      // devDependency workaround sibling packages already use for the same
      // reason. Versions match each package's current deno.json version;
      // bump alongside them.
      "@pgfsm/compiler": "^0.1.0-alpha.1",
      "@pgfsm/db": "^0.2.0",
      "@pgfsm/async-worker": "^0.1.0",
      "@pgfsm/sync-worker": "^0.1.0",
    },
    // pg ships no types of its own; dnt only auto-installs packages that are
    // themselves import specifiers, so without this the type-check pass
    // can't resolve `import ... from "pg"` (fsmdev.ts/run-gateway.ts import
    // it directly now, unlike when this package only built index.ts).
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
