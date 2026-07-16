import { createRequire } from "node:module";
import type { ReleaseType } from "semver";
import { getNextPkgVersionFilename } from "./get-next-pkg-version-util.ts";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

const incrementType = (process.argv[2] ?? "patch") as ReleaseType;

try {
  const filename = getNextPkgVersionFilename(pkg.name, incrementType);
  process.stdout.write(filename);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
