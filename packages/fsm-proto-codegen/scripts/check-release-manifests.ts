// Release-consistency check for one set of four packages published from this
// package (see README's "Publishing"): gen/ (the async contracts, the
// default) or gen-sync/ (the Sync Executor contract), chosen with --dir. Run
// by the proto-codegen workflow on every PR, and by proto-publish.yml at
// release time with the tag's version:
//
//   deno run --allow-read packages/fsm-proto-codegen/scripts/check-release-manifests.ts [--dir gen|gen-sync] [expected-version]
//
// Checks:
// 1. <dir>/typescript/deno.json, <dir>/python/pyproject.toml and
//    <dir>/rust/Cargo.toml all carry the same `version` (and, when given, the
//    expected version from the release tag). Go has no version field — its
//    release tag is derived from this same version.
// 2. pyproject.toml's protobuf lower bound equals the gencode version stamped
//    into every generated _pb2.py ("# Protobuf Python Version: X.Y.Z"). Each
//    module calls ValidateProtobufRuntimeVersion at import time, so an older
//    runtime installs fine and then raises VersionError on import.
// Cross-platform: pure Deno, no shell-outs.

const args = [...Deno.args];
const dirFlag = args.indexOf("--dir");
const DIR = dirFlag === -1 ? "gen" : args.splice(dirFlag, 2)[1];
if (DIR !== "gen" && DIR !== "gen-sync") {
  console.error(`error: --dir must be gen or gen-sync, got ${DIR}`);
  Deno.exit(2);
}
const GEN = new URL(`../${DIR}/`, import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, GEN));

// First `version = "..."` at the start of a line — the [package]/[project]
// table's, since neither manifest puts another table with a version above it.
function tomlVersion(path: string): string {
  const match = read(path).match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error(`no version field in ${DIR}/${path}`);
  return match[1];
}

const errors: string[] = [];

const versions: Record<string, string> = {
  [`${DIR}/typescript/deno.json`]: JSON.parse(read("typescript/deno.json"))
    .version,
  [`${DIR}/python/pyproject.toml`]: tomlVersion("python/pyproject.toml"),
  [`${DIR}/rust/Cargo.toml`]: tomlVersion("rust/Cargo.toml"),
};

const expected = args[0]?.replace(/^v/, "");
const distinct = new Set(Object.values(versions));
if (distinct.size !== 1 || (expected && !distinct.has(expected))) {
  const context = expected
    ? ` (expected ${expected} from the release tag)`
    : "";
  const listing = Object.entries(versions)
    .map(([file, v]) => `  ${file}: ${v}`)
    .join("\n");
  errors.push(`manifest versions disagree${context}:\n${listing}`);
}

const pyproject = read("python/pyproject.toml");
const lowerBound = pyproject.match(/"protobuf>=([0-9.]+)/)?.[1];
const gencodeVersions = new Set<string>();
for (const service of Deno.readDirSync(new URL("python/pgfsm/", GEN))) {
  if (!service.isDirectory) continue;
  const dir = new URL(`python/pgfsm/${service.name}/v1/`, GEN);
  for (const file of Deno.readDirSync(dir)) {
    if (!file.name.endsWith("_pb2.py")) continue;
    const stamp = Deno.readTextFileSync(new URL(file.name, dir))
      .match(/^# Protobuf Python Version: ([0-9.]+)$/m)?.[1];
    if (stamp) gencodeVersions.add(stamp);
  }
}
const [gencode] = gencodeVersions;
if (gencodeVersions.size !== 1) {
  const found = [...gencodeVersions].join(", ") || "none";
  errors.push(
    `expected one protobuf gencode version across ${DIR}/python/**/*_pb2.py, found: ${found}`,
  );
} else if (lowerBound !== gencode) {
  errors.push(
    `${DIR}/python/pyproject.toml requires protobuf>=${
      lowerBound ?? "?"
    }, but ` +
      `the generated _pb2.py files need runtime >= ${gencode}; set the lower bound to match.`,
  );
}

if (errors.length > 0) {
  for (const e of errors) console.error(`error: ${e}`);
  Deno.exit(1);
}
console.log(
  `${DIR} release manifests OK: version ${
    [...distinct][0]
  }, protobuf>=${lowerBound}`,
);
