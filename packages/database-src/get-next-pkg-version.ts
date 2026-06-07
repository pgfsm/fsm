import { createRequire } from "node:module";
import { getExistingHighestPkgVersion } from "./get-existing-highest-pkg-version.js";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

const pkgName: string = pkg.name;
const pkgVersion: string = pkg.version;

const existingHighest = getExistingHighestPkgVersion(pkgName);

function semverGt(a: string, b: string): boolean {
  const aParts = a.split(".").map(Number);
  const bParts = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (aParts[i] > bParts[i]) return true;
    if (aParts[i] < bParts[i]) return false;
  }
  return false;
}

let filename: string;

if (existingHighest === null) {
  filename = `${pkgName}--${pkgVersion}`;
} else if (pkgVersion === existingHighest) {
  console.error(
    `Error: migration file for version ${pkgVersion} already exists in migrations folder (highest recorded: ${existingHighest}). Update the version in package.json and .control file before generating a new migration.`,
  );
  process.exit(1);
} else if (semverGt(pkgVersion, existingHighest)) {
  filename = `${pkgName}--${existingHighest}--${pkgVersion}`;
} else {
  console.error(
    `Error: package.json version (${pkgVersion}) is behind the highest recorded migration version (${existingHighest}). Update package.json to a version higher than ${existingHighest} before generating a new migration.`,
  );
  process.exit(1);
}

process.stdout.write(filename);
