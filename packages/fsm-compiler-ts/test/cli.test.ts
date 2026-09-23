import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs/copy";
import { makeWorkspaceTempDir } from "./test-helpers.ts";
import { PACKAGE_VERSION } from "../src/cli/version.ts";

// Absolute, not relative to "packages/fsm-compiler-ts/..." — some tests below
// run the CLI with a different subprocess `cwd` (to exercise --output's
// relative-path resolution), which would otherwise break this path.
const CLI = `${Deno.cwd()}/packages/fsm-compiler-ts/src/cli/index.ts`;
// generate-fsm-json/delete/create-async-logic below invoke the real CLI as a
// subprocess against these paths, so they must never point at the tracked
// apps/fsm-core-example — that would delete/regenerate real committed files
// (see #125). Work on a disposable copy instead, cleaned up by the final
// test in this file. Must live inside this repo's own workspace tree, not a
// plain OS tmpdir — see test-helpers.ts.
const FIXTURE_ROOT = await makeWorkspaceTempDir("cli");
const APP_ROOT = `${FIXTURE_ROOT}/fsm-core-example`;
await copy("apps/fsm-core-example", APP_ROOT);
const FSM_FOLDER = `${APP_ROOT}/fsm`;
const SINGLE_FSM_JSON = `${FSM_FOLDER}/creditCheck/v01/fsm.json`;

async function runCli(
  args: string[],
  env?: Record<string, string>,
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", CLI, ...args],
    stdout: "piped",
    stderr: "piped",
    ...(env !== undefined && { env }),
    ...(cwd !== undefined && { cwd }),
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

// --- Help / no-args ---

Deno.test("cli --help exits 0 and prints usage", async () => {
  const { code, stdout } = await runCli(["--help"]);
  assertEquals(code, 0);
  assertStringIncludes(stdout, "fsm-compiler");
  assertStringIncludes(stdout, "USAGE");
  assertStringIncludes(stdout, "generate-fsm-json");
});

Deno.test("cli no args exits 0 and prints help", async () => {
  const { code, stdout } = await runCli([]);
  assertEquals(code, 0);
  assertStringIncludes(stdout, "USAGE");
});

Deno.test("cli -h shorthand exits 0", async () => {
  const { code } = await runCli(["-h"]);
  assertEquals(code, 0);
});

Deno.test("cli --version exits 0 and prints a bare version string", async () => {
  const { code, stdout } = await runCli(["--version"]);
  assertEquals(code, 0);
  // Bare, undecorated output (no logger timestamp/category prefix) — see
  // src/cli/index.ts's --version handling.
  assertEquals(stdout.trim(), PACKAGE_VERSION);
});

Deno.test("cli -v shorthand exits 0 and prints a bare version string", async () => {
  const { code, stdout } = await runCli(["-v"]);
  assertEquals(code, 0);
  assertEquals(stdout.trim(), PACKAGE_VERSION);
});

// --- Missing required args ---

Deno.test("cli generate-fsm-json without folder exits 1", async () => {
  const { code, stderr } = await runCli(["-c", "generate-fsm-json"]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "--folder");
});

Deno.test("cli unknown command exits 1", async () => {
  const { code, stderr } = await runCli([
    "-c",
    "unknown-cmd",
    "-f",
    FSM_FOLDER,
  ]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "Unknown command");
});

// --- Input validation ---

Deno.test("cli nonexistent --folder exits 1", async () => {
  const { code, stderr } = await runCli([
    "-c",
    "generate-fsm-json",
    "-f",
    "this/path/does/not/exist",
  ]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "does not exist");
});

// --- generate-fsm-json ---

Deno.test("cli generate-fsm-json runs successfully on example folder", async () => {
  const { code } = await runCli(["-c", "generate-fsm-json", "-f", FSM_FOLDER]);
  assertEquals(code, 0);
});

Deno.test("cli generate-fsm-json with --show-recommendation exits 0", async () => {
  const { code } = await runCli([
    "-c",
    "generate-fsm-json",
    "-f",
    FSM_FOLDER,
    "--show-recommendation",
  ]);
  assertEquals(code, 0);
});

Deno.test("cli generate-fsm-json with -r shorthand exits 0", async () => {
  const { code } = await runCli([
    "-c",
    "generate-fsm-json",
    "-f",
    FSM_FOLDER,
    "-r",
  ]);
  assertEquals(code, 0);
});

// --- generate-fsm-json single-machine.ts-file (--output) mode ---

Deno.test("cli generate-fsm-json requires --output when --folder is a single machine.ts file", async () => {
  const { code, stderr } = await runCli([
    "-c",
    "generate-fsm-json",
    "-f",
    `${FSM_FOLDER}/creditCheck/v01/machine.ts`,
  ]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "requires --output");
});

Deno.test("cli generate-fsm-json --folder machine.ts + --output creates --output (even nested/nonexistent) and writes fsm.json/xstate-fsm.json into it", async () => {
  const outDir = `${FIXTURE_ROOT}/generate-single-file-fresh-output/nested/v04`;
  const { code } = await runCli([
    "-c",
    "generate-fsm-json",
    "-f",
    `${FSM_FOLDER}/creditCheck/v01/machine.ts`,
    "--output",
    outDir,
  ]);
  assertEquals(code, 0);
  const fsmJsonStat = await Deno.stat(`${outDir}/fsm.json`);
  assert(fsmJsonStat.isFile);
  const xstateFsmJsonStat = await Deno.stat(`${outDir}/xstate-fsm.json`);
  assert(xstateFsmJsonStat.isFile);
});

Deno.test("cli generate-fsm-json exits 1 (not 0) when machine.ts's export is not a valid xstate machine config (#214)", async () => {
  const brokenDir = `${FIXTURE_ROOT}/broken-machine-single-file`;
  await Deno.mkdir(brokenDir, { recursive: true });
  await Deno.writeTextFile(
    `${brokenDir}/machine.ts`,
    "export default { notAMachine: true };\n",
  );
  const { code, stderr } = await runCli([
    "-c",
    "generate-fsm-json",
    "-f",
    `${brokenDir}/machine.ts`,
    "--output",
    `${FIXTURE_ROOT}/broken-machine-single-file-output`,
  ]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "not a valid xstate machine config");
});

// --- generate-async-logic / generate-sync-logic ---

Deno.test("cli generate-async-logic runs successfully on example folder", async () => {
  const { code } = await runCli([
    "-c",
    "generate-async-logic",
    "-f",
    FSM_FOLDER,
  ]);
  assertEquals(code, 0);
});

Deno.test("cli generate-async-logic folder mode writes the aggregate registry one level above --folder, with no --plugin-root flag needed", async () => {
  const { code } = await runCli([
    "-c",
    "generate-async-logic",
    "-f",
    FSM_FOLDER,
  ]);
  assertEquals(code, 0);
  // APP_ROOT is one level above FSM_FOLDER.
  const aggregateContent = await Deno.readTextFile(
    `${APP_ROOT}/worker-sdk-generated/typescript/typescript-actors-registry.generated.ts`,
  );
  assertStringIncludes(aggregateContent, "creditcheck_v01");
});

Deno.test("cli generate-sync-logic runs successfully on example folder", async () => {
  const { code } = await runCli([
    "-c",
    "generate-sync-logic",
    "-f",
    FSM_FOLDER,
    "--lang",
    "typescript",
  ]);
  assertEquals(code, 0);
  const registryContent = await Deno.readTextFile(
    `${FSM_FOLDER}/creditCheck/v01/sync-worker/typescript/generated-sync-operation-registry.ts`,
  );
  assertStringIncludes(registryContent, 'fsmName: "creditCheck"');
  assertStringIncludes(registryContent, 'fsmVersion: "v01"');

  const originalFsmJson = await Deno.readTextFile(
    `${FSM_FOLDER}/creditCheck/v01/fsm.json`,
  );
  const copiedFsmJson = await Deno.readTextFile(
    `${FSM_FOLDER}/creditCheck/v01/sync-worker/typescript/fsm.json`,
  );
  assertEquals(copiedFsmJson, originalFsmJson);
});

Deno.test("cli generate-sync-logic rejects an invalid --lang", async () => {
  const { code } = await runCli([
    "-c",
    "generate-sync-logic",
    "-f",
    FSM_FOLDER,
    "--lang",
    "cobol",
  ]);
  assertEquals(code, 1);
});

Deno.test("cli generate-sync-logic rejects a valid OperationLang other than typescript", async () => {
  const { code } = await runCli([
    "-c",
    "generate-sync-logic",
    "-f",
    FSM_FOLDER,
    "--lang",
    "python",
  ]);
  assertEquals(code, 1);
});

// --- generate-sync-logic single-fsm.json (--output) mode ---

Deno.test("cli generate-sync-logic requires --output when --folder is a single fsm.json file", async () => {
  const { code, stderr } = await runCli([
    "-c",
    "generate-sync-logic",
    "-f",
    SINGLE_FSM_JSON,
  ]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "requires --output");
});

Deno.test("cli generate-sync-logic rejects a non-.json --folder file", async () => {
  const { code, stderr } = await runCli([
    "-c",
    "generate-sync-logic",
    "-f",
    `${FSM_FOLDER}/creditCheck/v01/machine.ts`,
    "--output",
    `${FIXTURE_ROOT}/single-file-non-json-output`,
  ]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "must be an fsm.json file");
});

Deno.test("cli generate-sync-logic --folder fsm.json + --output (absolute) writes stubs into --output, independent of --folder's location", async () => {
  const outDir = `${FIXTURE_ROOT}/single-file-abs-output`;
  const { code } = await runCli([
    "-c",
    "generate-sync-logic",
    "-f",
    SINGLE_FSM_JSON,
    "--output",
    outDir,
  ]);
  assertEquals(code, 0);
  for (const kind of ["actions", "guards", "delays"]) {
    const stat = await Deno.stat(
      `${outDir}/sync-worker/typescript/${kind}/index.ts`,
    );
    assert(stat.isFile);
  }
  const registryStat = await Deno.stat(
    `${outDir}/sync-worker/typescript/generated-sync-operation-registry.ts`,
  );
  assert(registryStat.isFile);
  const fsmJsonCopyStat = await Deno.stat(
    `${outDir}/sync-worker/typescript/fsm.json`,
  );
  assert(fsmJsonCopyStat.isFile);
});

Deno.test("cli generate-sync-logic --output accepts a relative path, resolved against the CLI's cwd", async () => {
  const cwd = `${FIXTURE_ROOT}/single-file-relative-cwd`;
  await Deno.mkdir(cwd, { recursive: true });
  const { code } = await runCli(
    ["-c", "generate-sync-logic", "-f", SINGLE_FSM_JSON, "--output", "rel-out"],
    undefined,
    cwd,
  );
  assertEquals(code, 0);
  const stat = await Deno.stat(
    `${cwd}/rel-out/sync-worker/typescript/actions/index.ts`,
  );
  assert(stat.isFile);
});

Deno.test("cli generate-sync-logic --output writes to any target folder, unrelated to --folder's own directory name", async () => {
  // Copy fsm.json out to a location that looks nothing like a
  // <fsmName>/<version> folder, to prove --output is the only thing that
  // determines where stubs land.
  const draftDir = `${FIXTURE_ROOT}/scratch-draft`;
  await Deno.mkdir(draftDir, { recursive: true });
  const draftJson = `${draftDir}/fsm.json`;
  await Deno.copyFile(SINGLE_FSM_JSON, draftJson);

  const outDir = `${FIXTURE_ROOT}/single-file-unrelated-output`;
  const { code } = await runCli([
    "-c",
    "generate-sync-logic",
    "-f",
    draftJson,
    "--output",
    outDir,
  ]);
  assertEquals(code, 0);
  const stat = await Deno.stat(
    `${outDir}/sync-worker/typescript/actions/index.ts`,
  );
  assert(stat.isFile);
});

// --- generate-async-logic single-fsm.json (--output) mode ---

Deno.test("cli generate-async-logic requires --output when --folder is a single fsm.json file", async () => {
  const { code, stderr } = await runCli([
    "-c",
    "generate-async-logic",
    "-f",
    SINGLE_FSM_JSON,
  ]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "requires --output");
});

Deno.test("cli generate-async-logic rejects a non-.json --folder file", async () => {
  const { code, stderr } = await runCli([
    "-c",
    "generate-async-logic",
    "-f",
    `${FSM_FOLDER}/creditCheck/v01/machine.ts`,
    "--output",
    `${FIXTURE_ROOT}/async-single-file-non-json-output`,
  ]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "must be an fsm.json file");
});

Deno.test("cli generate-async-logic --folder fsm.json + --output writes actor files/manifest/registry into --output, independent of --folder's location", async () => {
  const outDir = `${FIXTURE_ROOT}/async-single-file-output`;
  const { code } = await runCli([
    "-c",
    "generate-async-logic",
    "-f",
    SINGLE_FSM_JSON,
    "--output",
    outDir,
  ]);
  assertEquals(code, 0);
  await Deno.stat(`${outDir}/actors-manifest.json`);
  await Deno.stat(
    `${outDir}/typescript/actors/verifyCredentials/verifyCredentials.ts`,
  );
  await Deno.stat(`${outDir}/typescript/actors/index.ts`);
  const registryStat = await Deno.stat(
    `${outDir}/typescript/actors/generated-registry.ts`,
  );
  assert(registryStat.isFile);
});

Deno.test("cli generate-async-logic single-fsm.json mode refreshes the aggregate registry / worker SDK at --output, with no --plugin-root flag needed", async () => {
  const outDir = `${FIXTURE_ROOT}/async-single-file-aggregate`;
  const { code } = await runCli([
    "-c",
    "generate-async-logic",
    "-f",
    SINGLE_FSM_JSON,
    "--output",
    outDir,
  ]);
  assertEquals(code, 0);
  const aggregateContent = await Deno.readTextFile(
    `${outDir}/worker-sdk-generated/typescript/typescript-actors-registry.generated.ts`,
  );
  // SINGLE_FSM_JSON is creditCheck/v01 -- its actors should be in the
  // rebuilt aggregate even though this run only scaffolded --output, not
  // the whole plugin root.
  assertStringIncludes(aggregateContent, "creditcheck_v01");
  // And the import path must correctly cross from outDir back to
  // FSM_FOLDER's actual creditCheck/v01, not assume they're the same tree.
  assertStringIncludes(
    aggregateContent,
    "creditCheck/v01/typescript/actors/generated-registry.ts",
  );
});

// --- generate-all ---

Deno.test("cli generate-all folder mode runs generate-fsm-json, generate-async-logic, and generate-sync-logic in sequence", async () => {
  const { code } = await runCli(["-c", "generate-all", "-f", FSM_FOLDER]);
  assertEquals(code, 0);

  const fsmJsonStat = await Deno.stat(`${FSM_FOLDER}/creditCheck/v01/fsm.json`);
  assert(fsmJsonStat.isFile);
  const actorStat = await Deno.stat(
    `${FSM_FOLDER}/creditCheck/v01/typescript/actors/verifyCredentials/verifyCredentials.ts`,
  );
  assert(actorStat.isFile);
  const syncStat = await Deno.stat(
    `${FSM_FOLDER}/creditCheck/v01/sync-worker/typescript/actions/index.ts`,
  );
  assert(syncStat.isFile);
  // Aggregate written one level above the plugin-root folder, matching
  // generate-async-logic's own folder-mode default.
  const aggregateContent = await Deno.readTextFile(
    `${APP_ROOT}/worker-sdk-generated/typescript/typescript-actors-registry.generated.ts`,
  );
  assertStringIncludes(aggregateContent, "creditcheck_v01");
});

Deno.test("cli generate-all requires --output when --folder is a single machine.ts file", async () => {
  const { code, stderr } = await runCli([
    "-c",
    "generate-all",
    "-f",
    `${FSM_FOLDER}/creditCheck/v01/machine.ts`,
  ]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "requires --output");
});

Deno.test("cli generate-all single-file mode writes fsm.json, actor stubs, sync stubs, and the aggregate registry all into --output", async () => {
  // --output must sit at the conventional <pluginRoot>/<fsmName>/<version>
  // depth (matching the documented usage pattern) for the aggregate step to
  // find the real plugin root three levels up from the fsm.json it writes;
  // a flatter --output is a known, out-of-scope limitation inherited from
  // generateAsyncOperationLogicFromFsmJson (see #218).
  const outDir = `${FIXTURE_ROOT}/generate-all-single-file/creditCheck/v01`;
  const { code } = await runCli([
    "-c",
    "generate-all",
    "-f",
    `${FSM_FOLDER}/creditCheck/v01/machine.ts`,
    "--output",
    outDir,
  ]);
  assertEquals(code, 0);
  const fsmJsonStat = await Deno.stat(`${outDir}/fsm.json`);
  assert(fsmJsonStat.isFile);
  const actorStat = await Deno.stat(
    `${outDir}/typescript/actors/verifyCredentials/verifyCredentials.ts`,
  );
  assert(actorStat.isFile);
  const syncStat = await Deno.stat(
    `${outDir}/sync-worker/typescript/actions/index.ts`,
  );
  assert(syncStat.isFile);
  const aggregateStat = await Deno.stat(
    `${outDir}/worker-sdk-generated/typescript/typescript-actors-registry.generated.ts`,
  );
  assert(aggregateStat.isFile);
});

Deno.test("cli generate-all folder mode: one bad FSM's failure doesn't block stub generation for the others, but the command still exits 1", async () => {
  const dir = `${FIXTURE_ROOT}/generate-all-partial-failure`;
  await Deno.mkdir(`${dir}/goodFsm/v01`, { recursive: true });
  await Deno.mkdir(`${dir}/badFsm/v01`, { recursive: true });
  await copy(
    `${FSM_FOLDER}/creditCheck/v01/machine.ts`,
    `${dir}/goodFsm/v01/machine.ts`,
  );
  await Deno.writeTextFile(
    `${dir}/badFsm/v01/machine.ts`,
    "export default { notAMachine: true };\n",
  );

  const { code } = await runCli(["-c", "generate-all", "-f", dir]);
  assertEquals(code, 1);

  const goodFsmJson = await Deno.stat(`${dir}/goodFsm/v01/fsm.json`);
  assertEquals(goodFsmJson.isFile, true);
  const goodActorStat = await Deno.stat(
    `${dir}/goodFsm/v01/typescript/actors/verifyCredentials/verifyCredentials.ts`,
  );
  assertEquals(goodActorStat.isFile, true);

  let badFsmJsonExists = true;
  try {
    await Deno.stat(`${dir}/badFsm/v01/fsm.json`);
  } catch {
    badFsmJsonExists = false;
  }
  assertEquals(badFsmJsonExists, false);
});

Deno.test("cli generate-all requires --output when --folder is a single fsm.json file", async () => {
  const { code, stderr } = await runCli([
    "-c",
    "generate-all",
    "-f",
    SINGLE_FSM_JSON,
  ]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "requires --output");
});

Deno.test("cli generate-all fsm.json mode skips generate-fsm-json and writes actor + sync stubs and the aggregate registry into --output", async () => {
  const outDir = `${FIXTURE_ROOT}/generate-all-fsm-json-mode`;
  const { code, stdout } = await runCli([
    "-c",
    "generate-all",
    "-f",
    SINGLE_FSM_JSON,
    "--output",
    outDir,
  ]);
  assertEquals(code, 0);
  assertStringIncludes(stdout, "skipping generate-fsm-json");

  // No fsm.json/xstate-fsm.json write happens in this mode -- the one at
  // --folder (SINGLE_FSM_JSON) is used as-is, generateFsmJSONFromMachineFile
  // never runs.
  let outputFsmJsonExists = true;
  try {
    await Deno.stat(`${outDir}/fsm.json`);
  } catch {
    outputFsmJsonExists = false;
  }
  assertEquals(outputFsmJsonExists, false);

  const actorStat = await Deno.stat(
    `${outDir}/typescript/actors/verifyCredentials/verifyCredentials.ts`,
  );
  assert(actorStat.isFile);
  const syncStat = await Deno.stat(
    `${outDir}/sync-worker/typescript/actions/index.ts`,
  );
  assert(syncStat.isFile);
  const aggregateContent = await Deno.readTextFile(
    `${outDir}/worker-sdk-generated/typescript/typescript-actors-registry.generated.ts`,
  );
  assertStringIncludes(aggregateContent, "creditcheck_v01");
});

Deno.test("cli generate-all rejects a --folder file that's neither .ts nor .json", async () => {
  const txtPath = `${FIXTURE_ROOT}/generate-all-bad-extension.txt`;
  await Deno.writeTextFile(txtPath, "not a machine.ts or fsm.json\n");
  const { code, stderr } = await runCli(["-c", "generate-all", "-f", txtPath]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "must be a .ts or fsm.json file");
});

// --- create-async-logic ---

Deno.test("cli create-async-logic without --fsm-version exits 1", async () => {
  const { code, stderr } = await runCli([
    "-c",
    "create-async-logic",
    "-f",
    APP_ROOT,
    "--lang",
    "typescript",
    "--name",
    "checkCreditScoreCliTest",
  ]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "--fsm-version");
});

Deno.test("cli create-async-logic without --name exits 1", async () => {
  const { code, stderr } = await runCli([
    "-c",
    "create-async-logic",
    "-f",
    APP_ROOT,
    "--lang",
    "typescript",
    "--fsm-version",
    "v01",
  ]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "--name");
});

Deno.test("cli create-async-logic rejects an invalid --lang", async () => {
  const { code, stderr } = await runCli([
    "-c",
    "create-async-logic",
    "-f",
    APP_ROOT,
    "--lang",
    "cobol",
    "--fsm-version",
    "v01",
    "--name",
    "checkCreditScoreCliTest",
  ]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "--lang");
});

Deno.test("cli create-async-logic rejects a comma-separated --lang (exactly one language required)", async () => {
  const { code, stderr } = await runCli([
    "-c",
    "create-async-logic",
    "-f",
    APP_ROOT,
    "--lang",
    "typescript,python",
    "--fsm-version",
    "v01",
    "--name",
    "checkCreditScoreCliTest",
  ]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "--lang");
});

Deno.test("cli create-async-logic writes a single actor file under shared-async-op", async () => {
  const { code } = await runCli([
    "-c",
    "create-async-logic",
    "-f",
    APP_ROOT,
    "--lang",
    "typescript",
    "--fsm-version",
    "v01",
    "--name",
    "checkCreditScoreCliTest",
  ]);
  assertEquals(code, 0);
  const stat = await Deno.stat(
    `${APP_ROOT}/shared-async-op/v01/typescript/actors/checkCreditScoreCliTest/checkCreditScoreCliTest.ts`,
  );
  assertEquals(stat.isFile, true);
});

// --- delete ---

Deno.test("cli delete runs successfully on example folder", async () => {
  await runCli(["-c", "generate-fsm-json", "-f", FSM_FOLDER]);
  const { code } = await runCli(["-c", "delete", "-f", FSM_FOLDER]);
  assertEquals(code, 0);
  await runCli(["-c", "generate-fsm-json", "-f", FSM_FOLDER]); // restore generated files
});

// --- validate-sync-operation ---

Deno.test("cli validate-sync-operation runs successfully on example folder", async () => {
  const { code } = await runCli([
    "-c",
    "validate-sync-operation",
    "-f",
    FSM_FOLDER,
  ]);
  assertEquals(code, 0);
});

// --- validate-sync-operation single-fsm.json (--fsm-name/--fsm-version) mode ---

Deno.test("cli validate-sync-operation requires --fsm-name and --fsm-version when --folder is a single fsm.json file", async () => {
  const { code, stderr } = await runCli([
    "-c",
    "validate-sync-operation",
    "-f",
    SINGLE_FSM_JSON,
  ]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "--fsm-name");
  assertStringIncludes(stderr, "--fsm-version");
});

Deno.test("cli validate-sync-operation rejects a non-.json --folder file", async () => {
  const { code, stderr } = await runCli([
    "-c",
    "validate-sync-operation",
    "-f",
    `${FSM_FOLDER}/creditCheck/v01/machine.ts`,
    "--fsm-name",
    "creditCheck",
    "--fsm-version",
    "v01",
  ]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "must be an fsm.json file");
});

Deno.test("cli validate-sync-operation --folder fsm.json + --fsm-name/--fsm-version runs successfully", async () => {
  const { code } = await runCli([
    "-c",
    "validate-sync-operation",
    "-f",
    SINGLE_FSM_JSON,
    "--fsm-name",
    "creditCheck",
    "--fsm-version",
    "v01",
  ]);
  assertEquals(code, 0);
});

Deno.test("cli validate-sync-operation --folder fsm.json accepts -N/-V shorthand", async () => {
  const { code } = await runCli([
    "-c",
    "validate-sync-operation",
    "-f",
    SINGLE_FSM_JSON,
    "-N",
    "creditCheck",
    "-V",
    "v01",
  ]);
  assertEquals(code, 0);
});

// --- validate-async-operation ---

Deno.test("cli validate-async-operation runs on vitalsWorkflow (shared, sharedAsyncOperation) folder", async () => {
  const { code } = await runCli([
    "-c",
    "validate-async-operation",
    "-f",
    FSM_FOLDER,
    "--skip-dirs",
    "carVitals,creditCheck,taskMachineConfig",
  ]);
  assertEquals(code, 0);
});

// --- DB-dependent commands (test flag parsing and early validation, no real DB required) ---

Deno.test("cli load without db connection string exits 1", async () => {
  const { code, stderr } = await runCli(
    ["-c", "load", "-f", FSM_FOLDER],
    { DATABASE_URL: "" },
  );
  assertEquals(code, 1);
  assertStringIncludes(stderr, "No database connection string");
});

Deno.test("cli --db-url flag is accepted and parsed", async () => {
  // With --db-url provided, buildDeps() should not print "No database connection string".
  // The connection itself will fail later (port 1 is not a DB), but the flag must be parsed.
  const { stderr } = await runCli(
    [
      "-c",
      "load",
      "-f",
      FSM_FOLDER,
      "--db-url",
      "postgresql://localhost:1/test",
    ],
    { DATABASE_URL: "" },
  );
  const isParseError = stderr.includes("No database connection string");
  assertEquals(isParseError, false);
});

// --- Flag acceptance tests ---

Deno.test("cli --skip-dirs flag is accepted", async () => {
  const { code } = await runCli([
    "-c",
    "generate-fsm-json",
    "-f",
    FSM_FOLDER,
    "--skip-dirs",
    "nonexistent",
  ]);
  assertEquals(code, 0);
});

// --- Cleanup ---
// Deno runs tests within a file sequentially in declaration order (absent
// --parallel), so this runs last and removes the fixture copy every prior
// test in this file wrote into.
Deno.test("cleanup fixture copy", async () => {
  await Deno.remove(FIXTURE_ROOT, { recursive: true });
});
