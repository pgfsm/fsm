import { build, emptyDir } from "@deno/dnt";

await emptyDir("./dist");

const packageVersion = Deno.args[0]?.replace(/^v/, "") ?? "0.0.0";

// @pgfsm/compiler and @pgfsm/db are published to npm independently and are
// genuinely imported as bare specifiers in fsmdev.ts's own compiled code
// (generate-all/pgcron steps call their library functions directly) — map
// them to the real npm dependency instead of letting dnt inline their
// source, same pattern as fsm-sync-worker-ts's build-npm.ts (#283/#289).
// Versions are read from each package's own deno.json rather than
// hardcoded, so they can't silently drift from whatever this build actually
// resolved locally.
const compilerDenoJson = JSON.parse(
  await Deno.readTextFile("../fsm-compiler-ts/deno.json"),
);
const compilerVersionRange = `^${compilerDenoJson.version}`;
const dbDenoJson = JSON.parse(
  await Deno.readTextFile("../fsm-core-db-ts/deno.json"),
);
const dbVersionRange = `^${dbDenoJson.version}`;

// @pgfsm/logging is published to npm independently too (#293) and is also
// genuinely imported as a bare specifier in fsmdev.ts's own compiled code
// (configureLogging/isTerminal) — same real-dependency treatment as
// @pgfsm/compiler/@pgfsm/db above.
const loggingDenoJson = JSON.parse(
  await Deno.readTextFile("../fsm-logging-ts/deno.json"),
);
const loggingVersionRange = `^${loggingDenoJson.version}`;

// @pgfsm/sync-worker and @pgfsm/async-worker are a different case (#251):
// fsmdev.ts no longer imports either as a JS module at all — the
// self-owned run-gateway.ts/run-fsmlet.ts wrapper bins that used to do that
// are gone, replaced with spawning those packages' own real published bins
// (fsmlet, async-operation-worker-gateway) directly by name. There's no
// bare specifier for dnt's mappings option to redirect, so these are a
// plain package.dependencies entry instead — declared purely so npm links
// their bins into node_modules/.bin alongside @pgfsm/devstack's own (the
// same mechanism `npx -p @pgfsm/sync-worker -- fsmlet` already relies on
// for that package's own bin), not because the compiled code imports them.
const syncWorkerDenoJson = JSON.parse(
  await Deno.readTextFile("../fsm-sync-worker-ts/deno.json"),
);
const syncWorkerVersionRange = `^${syncWorkerDenoJson.version}`;
const asyncWorkerDenoJson = JSON.parse(
  await Deno.readTextFile("../fsm-core-async-op-worker/deno.json"),
);
const asyncWorkerVersionRange = `^${asyncWorkerDenoJson.version}`;

await build({
  entryPoints: [
    "./src/index.ts",
    { kind: "bin", name: "fsmdev", path: "./src/cli/fsmdev.ts" },
  ],
  outDir: "./dist",
  shims: {
    deno: true,
  },
  mappings: {
    "@pgfsm/compiler": {
      name: "@pgfsm/compiler",
      version: compilerVersionRange,
    },
    "@pgfsm/db": { name: "@pgfsm/db", version: dbVersionRange },
    "@pgfsm/logging": { name: "@pgfsm/logging", version: loggingVersionRange },
  },
  // This package colocates supervisor.test.ts under src/ (the other dnt-built
  // packages' test files live outside src/) — without this, dnt also
  // transforms/type-checks it as a Node test file, pulling in @std/assert,
  // which needs a newer target lib than compilerOptions below sets.
  test: false,
  package: {
    name: "@pgfsm/devstack",
    version: packageVersion,
    description:
      "fsmdev: one-command local FSM dev stack launcher, plus the process spawn/signal supervision primitive backing it",
    license: "Apache-2.0",
    // pg ships no types of its own; dnt only auto-installs packages that are
    // themselves import specifiers, so without this the type-check pass
    // can't resolve `import ... from "pg"` (fsmdev.ts imports it directly).
    devDependencies: {
      "@types/pg": "^8.18.0",
    },
    // See the mappings comment above for why these two are here purely for
    // bin-on-PATH linking, not because the compiled code imports them.
    dependencies: {
      "@pgfsm/sync-worker": syncWorkerVersionRange,
      "@pgfsm/async-worker": asyncWorkerVersionRange,
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
