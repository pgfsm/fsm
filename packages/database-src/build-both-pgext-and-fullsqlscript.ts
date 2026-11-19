// Builds fsm_core's PGXN extension bundle (SPEC-016 A2) for a version whose
// files already exist. A pure build step: it never creates a version, touches
// Supabase or writes migrations.
//
//   npm run buildBothPgextAndFullsqlscript -- --version 2.3.2
//
// To create a new version first, generate it, review the new upgrade script,
// then build:
//
//   npm run generateBothPgextAndFullsqlscript -- patch   # prints the version
//   npm run buildBothPgextAndFullsqlscript -- --version <that version>
//
// CI's install test and the release call it the same way. It:
//
// 1. clear pgxn-dist/;
// 2. require the full script all-output/fsm_core--<version>.sql;
// 3. require every upgrade script from the base install to <version> in
//    supabase/migrations/ (no gap);
// 4. copy them into pgxn-dist/ (timestamp prefixes stripped);
// 5. fill the templates (control file, META.json) and copy the README;
// 6. zip it as fsm_core-<version>.zip, keeping pgxn-dist/;
// 7. require the plain-SQL install
//    all-output-with-prerequisite-check/fsm_core--<version>.sql;
// 8. collect the release files in full-release/full-release-<version>/: the
//    zip and that plain-SQL install, replacing any earlier copy of the folder.
//
// The plain-SQL install with prerequisite checks
// (all-output-with-prerequisite-check/) is the dump script's: it writes one
// next to every full script it dumps.
//
// The bundle is the standard extension layout: fsm_core--<version>.sql for
// CREATE EXTENSION, fsm_core--<a>--<b>.sql for ALTER EXTENSION … UPDATE.
// Nothing is uploaded: publishing to PGXN is fsm-core-release.yml's job.
import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import semver from "semver";

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const USAGE =
  "Usage: --version <x.y.z> (to create a new version first: npm run generateBothPgextAndFullsqlscript -- patch|minor|major)";

let args: { version?: string };
let positionals: string[];
try {
  ({ values: args, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { version: { type: "string", short: "v" } },
    allowPositionals: true,
    strict: true,
  }));
} catch (err) {
  fail(`${(err as Error).message}. ${USAGE}`);
}
if (positionals.length > 0) {
  fail(`unexpected argument(s): ${positionals.join(" ")}. ${USAGE}`);
}
if (args.version === undefined) fail(USAGE);
if (!semver.valid(args.version)) {
  fail(`"${args.version}" is not a valid semver version.`);
}
const version: string = args.version;

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

const pkgName: string = pkg.name;
const description: string = pkg.description;
const author: string = pkg.author;
const license: string = pkg.license;

const MIGRATIONS_DIR = "supabase/migrations";
// The full scripts, fsm_core--<version>.sql: supabase-dump-for-full-version.ts
// writes them here.
const FULL_EXT_MIGRATIONS_DIR = "all-output";
const TEMPLATES_DIR = "pgxn-templates";
const TEMP_BUILD_DIR = "pgxn-dist";
const RELEASE_DIR = "full-release";
// The plain-SQL installs (prerequisites + full script), written by
// supabase-dump-for-full-version.ts next to each full script it dumps.
const PREREQUISITE_DIR = "all-output-with-prerequisite-check";

// A migration filename is either a full script (single version) or an
// upgrade script (old--new); both carry a timestamp prefix on disk that's
// stripped for the bundle.
type ParsedMigration =
  | { kind: "base"; toVersion: string; strippedName: string }
  | {
    kind: "upgrade";
    fromVersion: string;
    toVersion: string;
    strippedName: string;
  };

function parseMigrationFile(
  name: string,
  filename: string,
): ParsedMigration | null {
  const stripped = filename.replace(/^\d+_/, "");
  const baseMatch = stripped.match(new RegExp(`^${name}--([\\d.]+)\\.sql$`));
  if (baseMatch) {
    return { kind: "base", toVersion: baseMatch[1], strippedName: stripped };
  }
  const upgradeMatch = stripped.match(
    new RegExp(`^${name}--([\\d.]+)--([\\d.]+)\\.sql$`),
  );
  if (upgradeMatch) {
    return {
      kind: "upgrade",
      fromVersion: upgradeMatch[1],
      toVersion: upgradeMatch[2],
      strippedName: stripped,
    };
  }
  return null;
}

type Migration = { file: string; parsed: ParsedMigration };

function migrationsIn(dir: string): Migration[] {
  return readdirSync(dir)
    .map((file) => ({ file, parsed: parseMigrationFile(pkgName, file) }))
    .filter((m): m is Migration => m.parsed !== null);
}

// 1. Clear the staging directory first, so a failed build leaves no stale
//    bundle behind for the release to pick up.
rmSync(TEMP_BUILD_DIR, { recursive: true, force: true });
mkdirSync(TEMP_BUILD_DIR, { recursive: true });

// 2. The full script for `version` must exist in all-output.
const fullScript =
  (existsSync(FULL_EXT_MIGRATIONS_DIR)
    ? migrationsIn(FULL_EXT_MIGRATIONS_DIR)
    : []).find((m) =>
      m.parsed.kind === "base" && m.parsed.toVersion === version
    );
if (!fullScript) {
  fail(
    `no full script ${pkgName}--${version}.sql in ${FULL_EXT_MIGRATIONS_DIR}/. Create it with supabase-dump-for-full-version.ts.`,
  );
}

// 3. Every upgrade script from the base install up to `version` must exist in
//    supabase/migrations, with no gap and no duplicate.
const mainMigrations = migrationsIn(MIGRATIONS_DIR);
const base = mainMigrations.find((m) => m.parsed.kind === "base");
if (!base) {
  fail(`no base install (${pkgName}--<version>.sql) in ${MIGRATIONS_DIR}.`);
}
const baseVersion = base.parsed.toVersion;
if (semver.lt(version, baseVersion)) {
  fail(`${version} is older than the base install, ${baseVersion}.`);
}
const upgrades = mainMigrations
  .filter((m) =>
    m.parsed.kind === "upgrade" && semver.lte(m.parsed.toVersion, version)
  )
  .sort((a, b) => semver.compare(a.parsed.toVersion, b.parsed.toVersion));

const problems: string[] = [];
let reached = baseVersion;
for (const u of upgrades) {
  const p = u.parsed as Extract<ParsedMigration, { kind: "upgrade" }>;
  if (p.fromVersion !== reached) {
    problems.push(
      p.toVersion === reached
        ? `duplicate upgrade to ${p.toVersion}: ${u.file}`
        : `missing ${pkgName}--${reached}--${p.fromVersion}.sql (the chain reaches ${reached}, ${u.file} starts at ${p.fromVersion})`,
    );
  }
  reached = p.toVersion;
}
if (reached !== version) {
  problems.push(
    `missing ${pkgName}--${reached}--${version}.sql (the chain ends at ${reached})`,
  );
}
if (problems.length > 0) {
  fail(
    `the upgrade chain in ${MIGRATIONS_DIR} from ${baseVersion} to ${version} is incomplete:\n  - ${
      problems.join("\n  - ")
    }`,
  );
}

// 4. The full script for `version` and every upgrade script up to it, with
//    the timestamp prefix stripped.
copyFileSync(
  join(FULL_EXT_MIGRATIONS_DIR, fullScript.file),
  join(TEMP_BUILD_DIR, fullScript.parsed.strippedName),
);
console.log(
  `Copied: ${FULL_EXT_MIGRATIONS_DIR}/${fullScript.file} → ${fullScript.parsed.strippedName}`,
);
for (const u of upgrades) {
  copyFileSync(
    join(MIGRATIONS_DIR, u.file),
    join(TEMP_BUILD_DIR, u.parsed.strippedName),
  );
  console.log(`Copied: ${MIGRATIONS_DIR}/${u.file} → ${u.parsed.strippedName}`);
}

// 5. Fill the templates and copy the README.
const SPDX_TO_PGXN: Record<string, string> = {
  "apache-2.0": "apache_2_0",
  "mit": "mit",
  "postgresql": "postgresql",
  "bsd-2-clause": "bsd",
  "bsd-3-clause": "bsd",
  "gpl-2.0": "gpl_2",
  "gpl-3.0": "gpl_3",
};

const placeholders: Record<string, string> = {
  "{{NAME}}": pkgName,
  "{{VERSION}}": version,
  "{{DESCRIPTION}}": description,
  "{{AUTHOR}}": author,
  "{{LICENSE_PGXN}}": SPDX_TO_PGXN[license.toLowerCase()] ??
    license.toLowerCase(),
  "{{PROVIDES_FILE}}": fullScript.parsed.strippedName,
};

function fillTemplate(content: string): string {
  let result = content;
  for (const [key, value] of Object.entries(placeholders)) {
    result = result.replaceAll(key, value);
  }
  return result;
}

writeFileSync(
  join(TEMP_BUILD_DIR, `${pkgName}.control`),
  fillTemplate(readFileSync(join(TEMPLATES_DIR, "extension.control"), "utf8")),
);
console.log(`Wrote ${pkgName}.control`);
writeFileSync(
  join(TEMP_BUILD_DIR, "META.json"),
  fillTemplate(readFileSync(join(TEMPLATES_DIR, "META.json"), "utf8")),
);
console.log(`Wrote META.json`);
copyFileSync("README.md", join(TEMP_BUILD_DIR, "README.md"));
console.log(`Wrote README.md`);

console.log(`\nStaging dir contents:`);
readdirSync(TEMP_BUILD_DIR).forEach((f) => console.log(`  ${f}`));

// 6. Zip via git archive, from a throwaway git repo in a temp dir so the
//    working tree stays clean (pgxn-dist is untracked). pgxn-dist is kept.
const zipName = `${pkgName}-${version}.zip`;
const tmpRepo = join(tmpdir(), `pgxn-build-${Date.now()}`);
try {
  mkdirSync(tmpRepo, { recursive: true });
  execSync(`cp -r "${TEMP_BUILD_DIR}/." "${tmpRepo}/"`, { shell: true });
  execSync(`git init -q "${tmpRepo}"`, { shell: true });
  execSync(`git -C "${tmpRepo}" add .`, { shell: true, stdio: "pipe" });
  const treeHash = execSync(`git -C "${tmpRepo}" write-tree`, {
    encoding: "utf8",
    shell: true,
  }).trim();
  execSync(
    `git -C "${tmpRepo}" archive --format=zip --prefix="${pkgName}-${version}/" "${treeHash}" > "${
      join(process.cwd(), zipName)
    }"`,
    { shell: true, stdio: "inherit" },
  );
} finally {
  rmSync(tmpRepo, { recursive: true, force: true });
}
console.log(`\nCreated: ${zipName} (staged files kept in ${TEMP_BUILD_DIR}/)`);

// 7. The plain-SQL install (prerequisites + full script) must exist: the
//    dump script writes it next to each full script it dumps.
const plainInstall = `${pkgName}--${version}.sql`;
if (!existsSync(join(PREREQUISITE_DIR, plainInstall))) {
  fail(
    `no plain-SQL install ${PREREQUISITE_DIR}/${plainInstall}. Create it with supabase-dump-for-full-version.ts.`,
  );
}

// 8. The release files for this version, together: the PGXN zip and the
//    plain-SQL install, in full-release/full-release-<version>/ (cleared
//    first, so it holds only this build's files).
const releaseDir = join(RELEASE_DIR, `full-release-${version}`);
rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });
copyFileSync(zipName, join(releaseDir, zipName));
copyFileSync(
  join(PREREQUISITE_DIR, plainInstall),
  join(releaseDir, plainInstall),
);
console.log(`Created: ${releaseDir}/ (${zipName}, ${plainInstall})`);
