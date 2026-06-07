import { execSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { getExistingHighestPkgVersion } from "./get-existing-highest-pkg-version.js";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

const pkgName: string = pkg.name;
const version: string = pkg.version;
const description: string = pkg.description;
const author: string = pkg.author;
const license: string = pkg.license;

const MIGRATIONS_DIR = "supabase/migrations";
const TEMPLATES_DIR = "pgxn-templates";
const TEMP_BUILD_DIR = "pgxn-dist";

// Guard: package.json version must be present as the highest migration version
const existingHighest = getExistingHighestPkgVersion(pkgName, MIGRATIONS_DIR);
if (existingHighest === null) {
  console.error(
    `Error: no migration files found for ${pkgName} in ${MIGRATIONS_DIR}. Create a migration before building.`,
  );
  process.exit(1);
}
if (existingHighest !== version) {
  console.error(
    `Error: package.json version (${version}) does not match the highest migration version (${existingHighest}). Create a migration for ${version} before building.`,
  );
  process.exit(1);
}

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
  "{{LICENSE_PGXN}}": SPDX_TO_PGXN[license.toLowerCase()] ?? license.toLowerCase(),
};

function fillTemplate(content: string): string {
  let result = content;
  for (const [key, value] of Object.entries(placeholders)) {
    result = result.replaceAll(key, value);
  }
  return result;
}

// 1. Clean and recreate pgxn-dist
rmSync(TEMP_BUILD_DIR, { recursive: true, force: true });
mkdirSync(TEMP_BUILD_DIR, { recursive: true });
console.log(`Created ${TEMP_BUILD_DIR}/`);

// 2. Fill templates and write to pgxn-dist
const controlContent = fillTemplate(
  readFileSync(join(TEMPLATES_DIR, "extension.control"), "utf8"),
);
writeFileSync(join(TEMP_BUILD_DIR, `${pkgName}.control`), controlContent);
console.log(`Wrote ${pkgName}.control`);

const metaContent = fillTemplate(
  readFileSync(join(TEMPLATES_DIR, "META.json"), "utf8"),
);
writeFileSync(join(TEMP_BUILD_DIR, "META.json"), metaContent);
console.log(`Wrote META.json`);

// 3. Copy README
copyFileSync("README.md", join(TEMP_BUILD_DIR, "README.md"));
console.log(`Wrote README.md`);

// 5. Copy versioned migration files, stripping the timestamp prefix
const migrationPattern = new RegExp(`^\\d+_${pkgName}--.*\\.sql$`);
const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((f) =>
  migrationPattern.test(f)
);

if (migrationFiles.length === 0) {
  console.warn(
    `Warning: no migration files matching ${pkgName}--*.sql found in ${MIGRATIONS_DIR}`,
  );
} else {
  for (const file of migrationFiles) {
    const stripped = file.replace(/^\d+_/, "");
    copyFileSync(join(MIGRATIONS_DIR, file), join(TEMP_BUILD_DIR, stripped));
    console.log(`Copied: ${file} → ${stripped}`);
  }
}

console.log(`\n${TEMP_BUILD_DIR}/ contents:`);
readdirSync(TEMP_BUILD_DIR).forEach((f) => console.log(`  ${f}`));

// 6. Create zip via git archive using a throwaway git repo in a temp dir so
//    the main working tree stays clean (pgxn-dist is untracked).
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
    `git -C "${tmpRepo}" archive --format=zip --prefix="${pkgName}-${version}/" "${treeHash}" > "${join(process.cwd(), zipName)}"`,
    { shell: true, stdio: "inherit" },
  );
  console.log(`\nCreated: ${zipName}`);
} finally {
  rmSync(tmpRepo, { recursive: true, force: true });
}
