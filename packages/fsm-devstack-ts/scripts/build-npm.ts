import { build, emptyDir } from "@deno/dnt";

await emptyDir("./dist");

// fsmdev, run-gateway.ts, and run-fsmlet.ts are all registered as this
// package's own bins — the same pattern @pgfsm/sync-worker uses for
// fsmlet/fsmscheduler/fsmctl/pgcron and @pgfsm/async-worker uses for
// async-operation-worker-gateway/-ctl. Under Node, fsmdev spawns
// run-gateway/run-fsmlet by their bin name (see fsmdev.ts's `isDeno` branch
// in toProcessSpec) and relies on PATH to resolve them — npm links a
// package's own bin entries into node_modules/.bin alongside its
// dependencies', so this works whether @pgfsm/devstack ends up in a
// temporary npx install or a global one, without fsmdev needing to know
// anything about dnt's dist/ output layout. See
// packages/fsm-devstack-ts/CLAUDE.md for the full design, including why an
// earlier revision instead resolved run-gateway/run-fsmlet's compiled path
// directly (kept there as a documented dead end, not reused).
//
// @pgfsm/compiler, @pgfsm/db, @pgfsm/async-worker, and @pgfsm/sync-worker are
// NOT declared as npm `dependencies` below, deliberately — they're Deno
// workspace-resolved imports, not npm:/jsr: specifiers, so dnt vendors their
// actual source directly into this package's own dist output (confirmed
// empirically: @pgfsm/async-worker's own compiled package.json doesn't list
// @pgfsm/db as a dependency either, and its dist/ has no node_modules/@pgfsm
// at all — see PR #248 / #247, which documents the same vendoring for
// fsm-sync-worker-ts's and fsm-core-async-op-worker's use of @pgfsm/db).
// Declaring them here wouldn't change that — the compiled code never imports
// the bare specifier, so it would just install a redundant, never-executed
// copy — and would misleadingly imply a semver-bumped fix to one of those
// four packages reaches existing @pgfsm/devstack installs, which it does
// not: this package would need to be rebuilt and republished itself. See
// packages/fsm-devstack-ts/CLAUDE.md's "Vendored dependencies" note.
await build({
  entryPoints: [
    "./src/index.ts",
    { kind: "bin", name: "fsmdev", path: "./src/cli/fsmdev.ts" },
    {
      kind: "bin",
      name: "pgfsm-devstack-run-gateway",
      path: "./src/cli/run-gateway.ts",
    },
    {
      kind: "bin",
      name: "pgfsm-devstack-run-fsmlet",
      path: "./src/cli/run-fsmlet.ts",
    },
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
