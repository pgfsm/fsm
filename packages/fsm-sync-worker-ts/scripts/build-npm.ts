import { build, emptyDir } from "@deno/dnt";

await emptyDir("./dist");

const packageVersion = Deno.args[0]?.replace(/^v/, "") ?? "0.0.0";

// @pgfsm/db is published to npm independently — map it to the real npm
// dependency instead of letting dnt inline its source, so a fix published
// there reaches this package via semver instead of requiring a republish
// here too. Version is read from its own deno.json rather than hardcoded, so
// it can't silently drift from whatever this build actually resolved
// locally. Same pattern as fsm-compiler-ts's build-npm.ts mapping @pgfsm/db
// (#250).
const dbDenoJson = JSON.parse(
  await Deno.readTextFile("../fsm-core-db-ts/deno.json"),
);
const dbVersionRange = `^${dbDenoJson.version}`;

// @pgfsm/logging is published to npm independently too (#293) — same
// real-dependency treatment as @pgfsm/db above.
const loggingDenoJson = JSON.parse(
  await Deno.readTextFile("../fsm-logging-ts/deno.json"),
);
const loggingVersionRange = `^${loggingDenoJson.version}`;

await build({
  // Library only: the fsmctl/pgcron/fsmscheduler bins moved to @pgfsm/ctl
  // as `pgfsmctl` subcommands (SPEC-005).
  entryPoints: ["./src/index.ts"],
  outDir: "./dist",
  // Tests stay out of the npm build: dnt would otherwise type-check them
  // against lib ES2022, and the floating jsr:@std/assert@1 now uses ES2025
  // Set methods (#400).
  test: false,
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
    "@pgfsm/logging": { name: "@pgfsm/logging", version: loggingVersionRange },
  },
  package: {
    name: "@pgfsm/sync-worker",
    version: packageVersion,
    description:
      "fsmlet worker runtime library driving FSM instances for PostgreSQL-backed state machines (ops CLIs live in @pgfsm/ctl)",
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
