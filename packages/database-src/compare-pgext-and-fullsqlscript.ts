#!/usr/bin/env -S deno run --allow-all
// Checks that a version's two release forms install the same fsm_core
// (SPEC-016): the PostgreSQL extension and the full SQL script, both from
// full-release/full-release-<version>/ (build-both-pgext-and-fullsqlscript.ts
// --version <version> writes it):
//
//   fsm_core-<version>.zip   the extension (PGXN bundle)
//   fsm_core--<version>.sql  the full script (prerequisites + full SQL)
//
//   deno run --allow-all compare-pgext-and-fullsqlscript.ts <version> [--pg 16] [--keep]
//
// In Docker (install-test/Dockerfile: postgres:<pg> with pg_cron and pgmq) it
// starts two containers:
//
//   full  runs the full script in one transaction, as a login that owns the
//         database but isn't a superuser (as on managed Postgres);
//   ext   copies the extension's files into the extension directory and runs
//         CREATE EXTENSION fsm_core CASCADE.
//
// Both must be at <version>; then their fsm_core objects are compared
// (scripts/compare-fsm-core-catalog.ts: functions, tables, columns,
// constraints, indexes, types, grants, roles, the pg_cron job). Exits 1 and
// lists every difference otherwise. --pg picks the PostgreSQL major version
// (default 16); --keep leaves the containers running.

import { parseArgs } from "@std/cli/parse-args";
import { describe, diff } from "./scripts/compare-fsm-core-catalog.ts";
import {
  buildImage,
  createInstaller,
  psql,
  removeContainers,
  run,
  startPostgres,
  url,
} from "./scripts/install-test-docker.ts";

const args = parseArgs(Deno.args, {
  string: ["pg", "port"],
  boolean: ["keep", "help"],
  default: { pg: "16", port: "55440" },
});
const usage =
  "Usage: deno run --allow-all compare-pgext-and-fullsqlscript.ts <version> [--pg 16] [--port 55440] [--keep]";
const version = args._.map(String)[0];
if (args.help || args._.length !== 1 || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(usage);
  Deno.exit(2);
}
const pg = args.pg;
const basePort = Number(args.port);
const root = new URL("./", import.meta.url);
const releaseDir = new URL(`full-release/full-release-${version}/`, root);
const zipFile = new URL(`fsm_core-${version}.zip`, releaseDir);
const fullScript = new URL(`fsm_core--${version}.sql`, releaseDir);

// ── 1. The release folder and both files must exist ────────────────────────
const missing: string[] = [];
for (const f of [releaseDir, zipFile, fullScript]) {
  try {
    await Deno.stat(f);
  } catch {
    missing.push(f.pathname.replace(root.pathname, ""));
  }
}
if (missing.length > 0) {
  console.error(
    `Missing: ${
      missing.join(", ")
    }\nBuild the release first:\n  npm run buildBothPgextAndFullsqlscript -- --version ${version}\n(it needs all-output/fsm_core--${version}.sql and all-output-with-prerequisite-check/fsm_core--${version}.sql; create those with npm run generateBothPgextAndFullsqlscript).`,
  );
  Deno.exit(1);
}

const containers: string[] = [];
const extracted = await Deno.makeTempDir({ prefix: "fsm_core-ext-" });
let failed = false;

try {
  // ── 2. The extension's files, out of the zip ─────────────────────────────
  await run("unzip", ["-q", zipFile.pathname, "-d", extracted]);
  const extDir = `${extracted}/fsm_core-${version}`;
  const extFiles = [...Deno.readDirSync(extDir)]
    .filter((e) => e.name.endsWith(".sql") || e.name.endsWith(".control"))
    .map((e) => `${extDir}/${e.name}`);
  if (!extFiles.some((f) => f.endsWith("fsm_core.control"))) {
    throw new Error(`${zipFile.pathname} has no fsm_core.control`);
  }

  const image = await buildImage(pg);

  // ── 3. full: the full script, as a non-superuser that owns the database ──
  const full = `pgfsm-compare-${pg}-full`;
  containers.push(full);
  await startPostgres(image, full, basePort);
  await createInstaller(full);
  console.log(`full: fsm_core--${version}.sql (PostgreSQL ${pg})`);
  await psql(full, await Deno.readTextFile(fullScript), "installer");
  const fullVersion = (await psql(full, "SELECT fsm_core.version()")).trim();

  // ── 4. ext: CREATE EXTENSION from the zip's files ────────────────────────
  const ext = `pgfsm-compare-${pg}-ext`;
  containers.push(ext);
  await startPostgres(image, ext, basePort + 1);
  for (const f of extFiles) {
    await run("docker", [
      "cp",
      f,
      `${ext}:/usr/share/postgresql/${pg}/extension/`,
    ]);
  }
  console.log(`ext: CREATE EXTENSION fsm_core (PostgreSQL ${pg})`);
  await psql(ext, "CREATE EXTENSION fsm_core CASCADE;");
  const extVersion = (await psql(
    ext,
    "SELECT extversion FROM pg_extension WHERE extname = 'fsm_core'",
  )).trim();

  // ── 5. Same version, same objects ────────────────────────────────────────
  const problems: string[] = [];
  if (fullVersion !== version) {
    problems.push(
      `full: fsm_core.version() is ${fullVersion}, expected ${version}`,
    );
  }
  if (extVersion !== version) {
    problems.push(
      `ext: the extension's version is ${extVersion}, expected ${version}`,
    );
  }
  const fullCatalog = await describe(url(basePort, "installer"));
  const extCatalog = await describe(url(basePort + 1));
  problems.push(
    ...diff(fullCatalog, extCatalog).map((d) =>
      d.replace(/^only in A:/, "only in full:").replace(
        /^only in B:/,
        "only in ext:",
      )
        .replace(/\n {2}A: /, "\n  full: ").replace(/\n {2}B: /, "\n  ext:  ")
    ),
  );

  if (problems.length > 0) {
    failed = true;
    console.error(
      `\nfsm_core ${version} on PostgreSQL ${pg}: the extension and the full script differ (${problems.length}):\n${
        problems.join("\n")
      }`,
    );
  } else {
    console.log(
      `\nfsm_core ${version} on PostgreSQL ${pg}: the extension and the full script are identical (${
        Object.keys(fullCatalog).length
      } objects).`,
    );
  }
} catch (err) {
  failed = true;
  console.error(`\nError: ${(err as Error).message}`);
} finally {
  await Deno.remove(extracted, { recursive: true }).catch(() => {});
  if (args.keep) {
    console.log(
      `Kept: ${containers.join(", ")} (full at ${
        url(basePort, "installer")
      }, ext at ${url(basePort + 1)})`,
    );
  } else {
    await removeContainers(containers);
  }
}
if (failed) Deno.exit(1);
