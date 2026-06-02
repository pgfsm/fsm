import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { bumptype: { type: "string" } },
  strict: false,
});
const bumpType = values.bumptype ?? process.env.npm_config_bumptype ?? "minor";
// console.log(`Using bump type: ${bumpType}`);
const pkgName: string = pkg.name;
const oldVersion: string = pkg.version;

const migrationsDir = "supabase/migrations";
const suffix = `${pkgName}--${oldVersion}.sql`;
const exists = readdirSync(migrationsDir).some((f) => f.endsWith(suffix));

let filename: string;
if (exists) {
  const raw = execSync(`npm version ${bumpType} --no-git-tag-version`, {
    encoding: "utf8",
  }).trim();
  const newVersion = raw.replace(/^v/, "");
  filename = `${pkgName}--${oldVersion}--${newVersion}`;
} else {
  filename = `${pkgName}--${oldVersion}`;
}

process.stdout.write(filename);
