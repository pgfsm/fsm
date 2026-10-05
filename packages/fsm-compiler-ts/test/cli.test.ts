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

// --- generate-fsm-json single-machine.ts-file mode ({cwd}/fsm/<N>/<V>/, #376) ---

// A machine.ts outside any fsm/ tree, at a path whose folder names are NOT a
// valid <fsmName>/<fsmVersion> -- guessing identity from it would be wrong.
const LOOSE_MACHINE_DIR = `${FIXTURE_ROOT}/designs/a`;
await Deno.mkdir(LOOSE_MACHINE_DIR, { recursive: true });
await copy(
  `${FSM_FOLDER}/creditCheck/v01/machine.ts`,
  `${LOOSE_MACHINE_DIR}/machine.ts`,
);

Deno.test("cli generate-fsm-json requires --fsm-name and --fsm-version for a single machine.ts", async () => {
  const cwd = `${FIXTURE_ROOT}/gen-fsm-json-no-identity`;
  await Deno.mkdir(cwd, { recursive: true });
  for (const extra of [[], ["-N", "checkout"], ["-V", "v01"]]) {
    const { code, stderr } = await runCli(
      [
        "-c",
        "generate-fsm-json",
        "-f",
        `${LOOSE_MACHINE_DIR}/machine.ts`,
        ...extra,
      ],
      undefined,
      cwd,
    );
    assertEquals(code, 1);
    assertStringIncludes(stderr, "requires --fsm-name and --fsm-version");
  }
  assertEquals(await pathExists(`${cwd}/fsm`), false);
});

Deno.test("cli generate-fsm-json single machine.ts writes fsm.json + xstate-fsm.json to {cwd}/fsm/<N>/<V>/ and leaves machine.ts in place", async () => {
  const cwd = `${FIXTURE_ROOT}/gen-fsm-json-cwd`;
  await Deno.mkdir(cwd, { recursive: true });
  const { code } = await runCli(
    [
      "-c",
      "generate-fsm-json",
      "-f",
      `${LOOSE_MACHINE_DIR}/machine.ts`,
      "-N",
      "checkout",
      "-V",
      "v04",
    ],
    undefined,
    cwd,
  );
  assertEquals(code, 0);
  const target = `${cwd}/fsm/checkout/v04`;
  assert(await pathExists(`${target}/fsm.json`));
  assert(await pathExists(`${target}/xstate-fsm.json`));
  // machine.ts is not copied, and nothing is written next to the source.
  assertEquals(await pathExists(`${target}/machine.ts`), false);
  assertEquals(await pathExists(`${LOOSE_MACHINE_DIR}/fsm.json`), false);
  // -V fills in asyncOperationVersion, not the source folder name "a".
  const fsmJson = await Deno.readTextFile(`${target}/fsm.json`);
  assertStringIncludes(fsmJson, `"asyncOperationVersion": "v04"`);
  assertEquals(fsmJson.includes(`"asyncOperationVersion": "a"`), false);
});

Deno.test("cli generate-fsm-json single machine.ts already inside {cwd}/fsm/<N>/<V>/ compiles in place", async () => {
  const cwd = `${FIXTURE_ROOT}/gen-fsm-json-in-place`;
  const versionDir = `${cwd}/fsm/checkout/v01`;
  await Deno.mkdir(versionDir, { recursive: true });
  await copy(`${LOOSE_MACHINE_DIR}/machine.ts`, `${versionDir}/machine.ts`);
  const { code } = await runCli(
    [
      "-c",
      "generate-fsm-json",
      "-f",
      "fsm/checkout/v01/machine.ts",
      "-N",
      "checkout",
      "-V",
      "v01",
    ],
    undefined,
    cwd,
  );
  assertEquals(code, 0);
  assert(await pathExists(`${versionDir}/fsm.json`));
  assert(await pathExists(`${versionDir}/machine.ts`));
});

Deno.test("cli generate-fsm-json refuses to overwrite a different machine id's fsm.json unless --force", async () => {
  const cwd = `${FIXTURE_ROOT}/gen-fsm-json-id-guard`;
  const target = `${cwd}/fsm/checkout/v01`;
  await Deno.mkdir(target, { recursive: true });
  const foreign = JSON.stringify({ id: "someOtherMachine" }) + "\n";
  await Deno.writeTextFile(`${target}/fsm.json`, foreign);
  const argv = [
    "-c",
    "generate-fsm-json",
    "-f",
    `${LOOSE_MACHINE_DIR}/machine.ts`,
    "-N",
    "checkout",
    "-V",
    "v01",
  ];

  const refused = await runCli(argv, undefined, cwd);
  assertEquals(refused.code, 1);
  assertStringIncludes(refused.stderr, "--force");
  assertEquals(await Deno.readTextFile(`${target}/fsm.json`), foreign);
  assertEquals(await pathExists(`${target}/xstate-fsm.json`), false);

  const forced = await runCli([...argv, "--force"], undefined, cwd);
  assertEquals(forced.code, 0);
  assert((await Deno.readTextFile(`${target}/fsm.json`)) !== foreign);
});

Deno.test("cli rejects --output for every command", async () => {
  for (
    const argv of [
      ["-c", "generate-fsm-json", "-f", `${LOOSE_MACHINE_DIR}/machine.ts`],
      ["-c", "generate-all", "-f", SINGLE_FSM_JSON],
    ]
  ) {
    const out = `${FIXTURE_ROOT}/rejected-output`;
    const { code, stderr } = await runCli([...argv, "--output", out]);
    assertEquals(code, 1);
    assertStringIncludes(stderr, "--output is no longer supported");
    assertEquals(await pathExists(out), false);
  }
});

Deno.test("cli generate-fsm-json exits 1 (not 0) and writes nothing when machine.ts's export is not a valid xstate machine config (#214)", async () => {
  const brokenDir = `${FIXTURE_ROOT}/broken-machine-single-file`;
  await Deno.mkdir(brokenDir, { recursive: true });
  await Deno.writeTextFile(
    `${brokenDir}/machine.ts`,
    "export default { notAMachine: true };\n",
  );
  const cwd = `${FIXTURE_ROOT}/broken-machine-single-file-cwd`;
  await Deno.mkdir(cwd, { recursive: true });
  const { code, stderr } = await runCli(
    [
      "-c",
      "generate-fsm-json",
      "-f",
      `${brokenDir}/machine.ts`,
      "-N",
      "broken",
      "-V",
      "v01",
    ],
    undefined,
    cwd,
  );
  assertEquals(code, 1);
  assertStringIncludes(stderr, "not a valid xstate machine config");
  assertEquals(await pathExists(`${cwd}/fsm`), false);
});

// --- generate-async-logic / generate-sync-logic ---

Deno.test("cli generate-async-logic runs successfully on example folder", async () => {
  const cwd = `${FIXTURE_ROOT}/async-folder-mode-cwd`;
  await Deno.mkdir(cwd, { recursive: true });
  const { code } = await runCli(
    ["-c", "generate-async-logic", "-f", FSM_FOLDER],
    undefined,
    cwd,
  );
  assertEquals(code, 0);
});

Deno.test("cli generate-async-logic folder mode writes actors + aggregate registry under cwd's async-worker/, independent of --folder's location", async () => {
  const cwd = `${FIXTURE_ROOT}/async-folder-mode-cwd-2`;
  await Deno.mkdir(cwd, { recursive: true });
  const { code } = await runCli(
    ["-c", "generate-async-logic", "-f", FSM_FOLDER],
    undefined,
    cwd,
  );
  assertEquals(code, 0);
  const actorStat = await Deno.stat(
    `${cwd}/async-worker/typescript/creditCheck/v01/actors/verifyCredentials/verifyCredentials.ts`,
  );
  assert(actorStat.isFile);
  const aggregateContent = await Deno.readTextFile(
    `${cwd}/async-worker/typescript/typescript-actors-registry.generated.ts`,
  );
  assertStringIncludes(aggregateContent, "creditcheck_v01");
});

Deno.test("cli generate-sync-logic runs successfully on example folder, output anchored at cwd (not --folder)", async () => {
  const cwd = `${FIXTURE_ROOT}/folder-mode-cwd`;
  await Deno.mkdir(cwd, { recursive: true });
  const { code } = await runCli(
    ["-c", "generate-sync-logic", "-f", FSM_FOLDER, "--lang", "typescript"],
    undefined,
    cwd,
  );
  assertEquals(code, 0);
  // sync-worker/ is a direct child of cwd, never inside FSM_FOLDER/--folder.
  const registryContent = await Deno.readTextFile(
    `${cwd}/sync-worker/typescript/creditCheck/v01/generated-sync-operation-registry.ts`,
  );
  assertStringIncludes(registryContent, 'fsmName: "creditCheck"');
  assertStringIncludes(registryContent, 'fsmVersion: "v01"');

  const originalFsmJson = await Deno.readTextFile(
    `${FSM_FOLDER}/creditCheck/v01/fsm.json`,
  );
  const copiedFsmJson = await Deno.readTextFile(
    `${cwd}/sync-worker/typescript/creditCheck/v01/fsm.json`,
  );
  assertEquals(copiedFsmJson, originalFsmJson);

  let existsUnderFolder = true;
  try {
    await Deno.stat(`${FSM_FOLDER}/creditCheck/v01/sync-worker`);
  } catch {
    existsUnderFolder = false;
  }
  assertEquals(existsUnderFolder, false);
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

// --- generate-sync-logic single-fsm.json (--fsm-name/--fsm-version) mode ---

Deno.test("cli generate-sync-logic requires --fsm-name and --fsm-version when --folder is a single fsm.json file", async () => {
  const { code, stderr } = await runCli([
    "-c",
    "generate-sync-logic",
    "-f",
    SINGLE_FSM_JSON,
  ]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "requires --fsm-name and --fsm-version");
});

Deno.test("cli generate-sync-logic rejects a non-.json --folder file", async () => {
  const { code, stderr } = await runCli([
    "-c",
    "generate-sync-logic",
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

Deno.test("cli generate-sync-logic --folder fsm.json + --fsm-name/--fsm-version writes stubs under cwd's sync-worker/, independent of --folder's location", async () => {
  const cwd = `${FIXTURE_ROOT}/single-file-cwd`;
  await Deno.mkdir(cwd, { recursive: true });
  const { code } = await runCli(
    [
      "-c",
      "generate-sync-logic",
      "-f",
      SINGLE_FSM_JSON,
      "--fsm-name",
      "creditCheck",
      "--fsm-version",
      "v01",
    ],
    undefined,
    cwd,
  );
  assertEquals(code, 0);
  const outDir = `${cwd}/sync-worker/typescript/creditCheck/v01`;
  // One stub per operation (#460); this FSM has no delays.
  for (
    const stub of [
      "actions/assignSSN/assignSSN.ts",
      "guards/allSucceeded/allSucceeded.ts",
    ]
  ) {
    const stat = await Deno.stat(`${outDir}/${stub}`);
    assert(stat.isFile);
  }
  assertEquals(await pathExists(`${outDir}/actions/index.ts`), false);
  const registryStat = await Deno.stat(
    `${outDir}/generated-sync-operation-registry.ts`,
  );
  assert(registryStat.isFile);
  const fsmJsonCopyStat = await Deno.stat(`${outDir}/fsm.json`);
  assert(fsmJsonCopyStat.isFile);
});

Deno.test("cli generate-sync-logic single-file mode: output moves with cwd, not with --folder's own directory name", async () => {
  // Copy fsm.json out to a location that looks nothing like a
  // <fsmName>/<version> folder, to prove --folder's own location has no
  // bearing on where stubs land -- only cwd + --fsm-name/--fsm-version do.
  const draftDir = `${FIXTURE_ROOT}/scratch-draft`;
  await Deno.mkdir(draftDir, { recursive: true });
  const draftJson = `${draftDir}/fsm.json`;
  await Deno.copyFile(SINGLE_FSM_JSON, draftJson);

  const cwd = `${FIXTURE_ROOT}/single-file-unrelated-cwd`;
  await Deno.mkdir(cwd, { recursive: true });
  const { code } = await runCli(
    [
      "-c",
      "generate-sync-logic",
      "-f",
      draftJson,
      "--fsm-name",
      "creditCheck",
      "--fsm-version",
      "v01",
    ],
    undefined,
    cwd,
  );
  assertEquals(code, 0);
  const stat = await Deno.stat(
    `${cwd}/sync-worker/typescript/creditCheck/v01/actions/assignSSN/assignSSN.ts`,
  );
  assert(stat.isFile);
});

// --- generate-async-logic single-fsm.json (--fsm-name/--fsm-version) mode ---

Deno.test("cli generate-async-logic requires --fsm-name and --fsm-version when --folder is a single fsm.json file", async () => {
  const { code, stderr } = await runCli([
    "-c",
    "generate-async-logic",
    "-f",
    SINGLE_FSM_JSON,
  ]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "requires --fsm-name and --fsm-version");
});

Deno.test("cli generate-async-logic rejects a non-.json --folder file", async () => {
  const { code, stderr } = await runCli([
    "-c",
    "generate-async-logic",
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

Deno.test("cli generate-async-logic --folder fsm.json + --fsm-name/--fsm-version writes actor files/manifest/registry under cwd's async-worker/, independent of --folder's location", async () => {
  const cwd = `${FIXTURE_ROOT}/async-single-file-cwd`;
  await Deno.mkdir(cwd, { recursive: true });
  const { code } = await runCli(
    [
      "-c",
      "generate-async-logic",
      "-f",
      SINGLE_FSM_JSON,
      "--fsm-name",
      "creditCheck",
      "--fsm-version",
      "v01",
    ],
    undefined,
    cwd,
  );
  assertEquals(code, 0);
  const outDir = `${cwd}/async-worker/typescript/creditCheck/v01`;
  await Deno.stat(`${outDir}/actors-manifest.json`);
  await Deno.stat(
    `${outDir}/actors/verifyCredentials/verifyCredentials.ts`,
  );
  await Deno.stat(`${outDir}/actors/index.ts`);
  const registryStat = await Deno.stat(
    `${outDir}/generated-registry.ts`,
  );
  assert(registryStat.isFile);
});

Deno.test("cli generate-async-logic single-fsm.json mode refreshes the aggregate registry / worker SDK at cwd, with no --plugin-root flag needed", async () => {
  const cwd = `${FIXTURE_ROOT}/async-single-file-aggregate-cwd`;
  await Deno.mkdir(cwd, { recursive: true });
  const { code } = await runCli(
    [
      "-c",
      "generate-async-logic",
      "-f",
      SINGLE_FSM_JSON,
      "--fsm-name",
      "creditCheck",
      "--fsm-version",
      "v01",
    ],
    undefined,
    cwd,
  );
  assertEquals(code, 0);
  const aggregateContent = await Deno.readTextFile(
    `${cwd}/async-worker/typescript/typescript-actors-registry.generated.ts`,
  );
  // SINGLE_FSM_JSON is creditCheck/v01 -- its actors should be in the
  // rebuilt aggregate even though this run only scaffolded this one fsm.json,
  // not the whole plugin root.
  assertStringIncludes(aggregateContent, "creditcheck_v01");
  // The per-version registry now lives directly under the aggregate's own
  // cwd-anchored tree, not back-referenced into FSM_FOLDER's own location.
  assertStringIncludes(
    aggregateContent,
    "./creditCheck/v01/generated-registry.ts",
  );
});

// --- generate-all ---
// generate-all anchors async-worker/ + sync-worker/ at the subprocess cwd in
// every mode (#372), so each test below passes an explicit cwd.

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("cli generate-all folder mode runs generate-fsm-json, generate-async-logic, and generate-sync-logic in sequence, writing under cwd", async () => {
  const { code } = await runCli(
    ["-c", "generate-all", "-f", "fsm"],
    undefined,
    APP_ROOT,
  );
  assertEquals(code, 0);

  const fsmJsonStat = await Deno.stat(`${FSM_FOLDER}/creditCheck/v01/fsm.json`);
  assert(fsmJsonStat.isFile);
  const actorStat = await Deno.stat(
    `${APP_ROOT}/async-worker/typescript/creditCheck/v01/actors/verifyCredentials/verifyCredentials.ts`,
  );
  assert(actorStat.isFile);
  const syncStat = await Deno.stat(
    `${APP_ROOT}/sync-worker/typescript/creditCheck/v01/actions/assignSSN/assignSSN.ts`,
  );
  assert(syncStat.isFile);
  const aggregateContent = await Deno.readTextFile(
    `${APP_ROOT}/async-worker/typescript/typescript-actors-registry.generated.ts`,
  );
  assertStringIncludes(aggregateContent, "creditcheck_v01");
});

Deno.test("cli generate-all folder mode writes under cwd, not one level above --folder", async () => {
  const cwd = `${FIXTURE_ROOT}/generate-all-folder-cwd`;
  await Deno.mkdir(cwd, { recursive: true });
  const { code } = await runCli(
    ["-c", "generate-all", "-f", FSM_FOLDER, "--skip-dirs", "carVitals"],
    undefined,
    cwd,
  );
  assertEquals(code, 0);
  assert(
    await pathExists(
      `${cwd}/async-worker/typescript/creditCheck/v01/actors/verifyCredentials/verifyCredentials.ts`,
    ),
  );
  assert(
    await pathExists(
      `${cwd}/sync-worker/typescript/creditCheck/v01/actions/assignSSN/assignSSN.ts`,
    ),
  );
});

for (
  const [label, file] of [["fsm.json", "fsm.json"], [
    "machine.ts",
    "machine.ts",
  ]]
) {
  Deno.test(`cli generate-all requires --fsm-name and --fsm-version for a single ${label}, and never guesses from its folders`, async () => {
    // a/<file> relative to cwd: guessing would silently yield
    // fsmName = <cwd's own name>, fsmVersion = "a" (#372).
    const cwd = `${FIXTURE_ROOT}/generate-all-no-identity-${label}`;
    await Deno.mkdir(`${cwd}/a`, { recursive: true });
    await copy(
      `${FSM_FOLDER}/creditCheck/v01/${file}`,
      `${cwd}/a/${file}`,
    );
    for (
      const extra of [[], ["-N", "checkout"], ["-V", "v01"]]
    ) {
      const { code, stderr } = await runCli(
        ["-c", "generate-all", "-f", `a/${file}`, ...extra],
        undefined,
        cwd,
      );
      assertEquals(code, 1);
      assertStringIncludes(stderr, "requires --fsm-name and --fsm-version");
    }
    assertEquals(await pathExists(`${cwd}/async-worker`), false);
    assertEquals(await pathExists(`${cwd}/sync-worker`), false);
  });
}

Deno.test("cli generate-all machine.ts mode writes fsm.json to {cwd}/fsm/<N>/<V>/ and workers under cwd", async () => {
  const versionDir = `${FIXTURE_ROOT}/generate-all-machine-ts/fsm/checkout/v02`;
  await Deno.mkdir(versionDir, { recursive: true });
  await copy(
    `${FSM_FOLDER}/creditCheck/v01/machine.ts`,
    `${versionDir}/machine.ts`,
  );
  const cwd = `${FIXTURE_ROOT}/generate-all-machine-ts/app`;
  await Deno.mkdir(cwd, { recursive: true });

  const { code } = await runCli(
    [
      "-c",
      "generate-all",
      "-f",
      `${versionDir}/machine.ts`,
      "-N",
      "checkout",
      "-V",
      "v02",
    ],
    undefined,
    cwd,
  );
  assertEquals(code, 0);
  assert(await pathExists(`${cwd}/fsm/checkout/v02/fsm.json`));
  assert(await pathExists(`${cwd}/fsm/checkout/v02/xstate-fsm.json`));
  assertEquals(await pathExists(`${versionDir}/fsm.json`), false);
  assert(
    await pathExists(
      `${cwd}/async-worker/typescript/checkout/v02/actors/verifyCredentials/verifyCredentials.ts`,
    ),
  );
  assert(
    await pathExists(
      `${cwd}/sync-worker/typescript/checkout/v02/actions/assignSSN/assignSSN.ts`,
    ),
  );
  assert(
    await pathExists(
      `${cwd}/async-worker/typescript/typescript-actors-registry.generated.ts`,
    ),
  );
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
  const cwd = `${FIXTURE_ROOT}/generate-all-partial-failure-out`;
  await Deno.mkdir(cwd, { recursive: true });

  const { code } = await runCli(
    ["-c", "generate-all", "-f", dir],
    undefined,
    cwd,
  );
  assertEquals(code, 1);

  const goodFsmJson = await Deno.stat(`${dir}/goodFsm/v01/fsm.json`);
  assertEquals(goodFsmJson.isFile, true);
  const goodActorStat = await Deno.stat(
    `${cwd}/async-worker/typescript/goodFsm/v01/actors/verifyCredentials/verifyCredentials.ts`,
  );
  assertEquals(goodActorStat.isFile, true);
  assertEquals(await pathExists(`${dir}/badFsm/v01/fsm.json`), false);
});

Deno.test("cli generate-all fsm.json mode skips generate-fsm-json and writes actor + sync stubs and the aggregate registry under cwd", async () => {
  const cwd = `${FIXTURE_ROOT}/generate-all-fsm-json-mode`;
  await Deno.mkdir(cwd, { recursive: true });
  const { code, stdout } = await runCli(
    [
      "-c",
      "generate-all",
      "-f",
      SINGLE_FSM_JSON,
      "-N",
      "creditCheck",
      "-V",
      "v01",
    ],
    undefined,
    cwd,
  );
  assertEquals(code, 0);
  assertStringIncludes(stdout, "skipping generate-fsm-json");
  // The given fsm.json is copied into {cwd}/fsm/<N>/<V>/ (#376), so a later
  // `generate-all -f fsm` from cwd rebuilds without the original path.
  assertEquals(
    await Deno.readTextFile(`${cwd}/fsm/creditCheck/v01/fsm.json`),
    await Deno.readTextFile(SINGLE_FSM_JSON),
  );
  assertEquals(await pathExists(`${cwd}/fsm.json`), false);

  assert(
    await pathExists(
      `${cwd}/async-worker/typescript/creditCheck/v01/actors/verifyCredentials/verifyCredentials.ts`,
    ),
  );
  assert(
    await pathExists(
      `${cwd}/sync-worker/typescript/creditCheck/v01/actions/assignSSN/assignSSN.ts`,
    ),
  );
  const aggregateContent = await Deno.readTextFile(
    `${cwd}/async-worker/typescript/typescript-actors-registry.generated.ts`,
  );
  assertStringIncludes(aggregateContent, "creditcheck_v01");
});

Deno.test("cli generate-all fsm.json mode uses --fsm-name/--fsm-version, not the file's own folders", async () => {
  const flat = `${FIXTURE_ROOT}/generate-all-flat/checkout.json`;
  await Deno.mkdir(`${FIXTURE_ROOT}/generate-all-flat`, { recursive: true });
  await copy(SINGLE_FSM_JSON, flat);
  const cwd = `${FIXTURE_ROOT}/generate-all-flat-out`;
  await Deno.mkdir(cwd, { recursive: true });

  const { code } = await runCli(
    [
      "-c",
      "generate-all",
      "-f",
      flat,
      "--fsm-name",
      "checkout",
      "--fsm-version",
      "v03",
    ],
    undefined,
    cwd,
  );
  assertEquals(code, 0);
  assert(
    await pathExists(
      `${cwd}/async-worker/typescript/checkout/v03/actors/verifyCredentials/verifyCredentials.ts`,
    ),
  );
  assert(
    await pathExists(
      `${cwd}/sync-worker/typescript/checkout/v03/actions/assignSSN/assignSSN.ts`,
    ),
  );
});

Deno.test("cli generate-all rejects a --folder file that's neither .ts nor .json", async () => {
  const txtPath = `${FIXTURE_ROOT}/generate-all-bad-extension.txt`;
  await Deno.writeTextFile(txtPath, "not a machine.ts or fsm.json\n");
  const { code, stderr } = await runCli(["-c", "generate-all", "-f", txtPath]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "must be a .ts or fsm.json file");
});

// --- --overwrite (#381) ---

Deno.test("cli rejects an invalid --overwrite value", async () => {
  const { code, stderr } = await runCli([
    "-c",
    "generate-sync-logic",
    "-f",
    FSM_FOLDER,
    "--overwrite",
    "never",
  ]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "Invalid --overwrite value");
});

Deno.test("cli --overwrite generated-only keeps an edited stub on re-run and reports it", async () => {
  const cwd = `${FIXTURE_ROOT}/overwrite-generated-only`;
  await Deno.mkdir(cwd, { recursive: true });
  const argv = [
    "-c",
    "generate-sync-logic",
    "-f",
    SINGLE_FSM_JSON,
    "-N",
    "creditCheck",
    "-V",
    "v01",
    "--overwrite",
    "generated-only",
  ];
  assertEquals((await runCli(argv, undefined, cwd)).code, 0);
  const actions =
    `${cwd}/sync-worker/typescript/creditCheck/v01/actions/assignSSN/assignSSN.ts`;
  const edited = (await Deno.readTextFile(actions)) + "// mine\n";
  await Deno.writeTextFile(actions, edited);

  const { code, stdout } = await runCli(argv, undefined, cwd);
  assertEquals(code, 0);
  assertEquals(await Deno.readTextFile(actions), edited);
  assertStringIncludes(stdout, "Kept");
  assertStringIncludes(stdout, "kept.");
});

// --- create-async-logic ---

Deno.test("cli create-async-logic without --function-version exits 1", async () => {
  const { code, stderr } = await runCli(
    [
      "-c",
      "create-async-logic",
      "--lang",
      "typescript",
      "--function-name",
      "checkCreditScoreCliTest",
    ],
    undefined,
    APP_ROOT,
  );
  assertEquals(code, 1);
  assertStringIncludes(stderr, "--function-version");
});

Deno.test("cli create-async-logic without --function-name exits 1", async () => {
  const { code, stderr } = await runCli(
    [
      "-c",
      "create-async-logic",
      "--lang",
      "typescript",
      "--function-version",
      "v01",
    ],
    undefined,
    APP_ROOT,
  );
  assertEquals(code, 1);
  assertStringIncludes(stderr, "--function-name");
});

Deno.test("cli create-async-logic rejects an invalid --lang", async () => {
  const { code, stderr } = await runCli(
    [
      "-c",
      "create-async-logic",
      "--lang",
      "cobol",
      "--function-version",
      "v01",
      "--function-name",
      "checkCreditScoreCliTest",
    ],
    undefined,
    APP_ROOT,
  );
  assertEquals(code, 1);
  assertStringIncludes(stderr, "--lang");
});

Deno.test("cli create-async-logic rejects a comma-separated --lang (exactly one language required)", async () => {
  const { code, stderr } = await runCli(
    [
      "-c",
      "create-async-logic",
      "--lang",
      "typescript,python",
      "--function-version",
      "v01",
      "--function-name",
      "checkCreditScoreCliTest",
    ],
    undefined,
    APP_ROOT,
  );
  assertEquals(code, 1);
  assertStringIncludes(stderr, "--lang");
});

Deno.test("cli create-async-logic writes a single actor file under cwd's async-worker/sharedAsyncOperation, independent of --folder (there is none)", async () => {
  const { code } = await runCli(
    [
      "-c",
      "create-async-logic",
      "--lang",
      "typescript",
      "--function-version",
      "v01",
      "--function-name",
      "checkCreditScoreCliTest",
    ],
    undefined,
    APP_ROOT,
  );
  assertEquals(code, 0);
  const stat = await Deno.stat(
    `${APP_ROOT}/async-worker/typescript/sharedAsyncOperation/v01/actors/checkCreditScoreCliTest/checkCreditScoreCliTest.ts`,
  );
  assertEquals(stat.isFile, true);
});

// --- delete ---

Deno.test("cli delete runs successfully on example folder", async () => {
  // delete's own sync-worker/async-worker cleanup is Deno.cwd()-anchored
  // (matches whatever fsmName/fsmVersion it finds walking --folder) --
  // isolate it here, same as every generate-sync-logic/generate-async-logic
  // test below, so it can never reach outside this fixture.
  const cwd = `${FIXTURE_ROOT}/delete-cwd`;
  await Deno.mkdir(cwd, { recursive: true });
  await runCli(["-c", "generate-fsm-json", "-f", FSM_FOLDER]);
  const { code } = await runCli(
    ["-c", "delete", "-f", FSM_FOLDER],
    undefined,
    cwd,
  );
  assertEquals(code, 0);
  await runCli(["-c", "generate-fsm-json", "-f", FSM_FOLDER]); // restore generated files
});

// Sets up <cwd>/fsm/checkout/v01/{machine.ts,fsm.json,xstate-fsm.json} plus an
// implemented sync stub and async actor stub under <cwd>'s worker folders.
async function setUpDeleteFixture(name: string) {
  const cwd = `${FIXTURE_ROOT}/${name}`;
  const versionDir = `${cwd}/fsm/checkout/v01`;
  await Deno.mkdir(versionDir, { recursive: true });
  await copy(
    `${FSM_FOLDER}/creditCheck/v01/machine.ts`,
    `${versionDir}/machine.ts`,
  );
  await copy(SINGLE_FSM_JSON, `${versionDir}/fsm.json`);
  await Deno.writeTextFile(`${versionDir}/xstate-fsm.json`, "{}\n");
  const syncStub =
    `${cwd}/sync-worker/typescript/checkout/v01/actions/index.ts`;
  const actorStub =
    `${cwd}/async-worker/python/checkout/v01/actors/verifyCredentials/verifyCredentials.py`;
  for (const stub of [syncStub, actorStub]) {
    await Deno.mkdir(stub.substring(0, stub.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeTextFile(stub, "// implemented by hand\n");
  }
  return { cwd, versionDir, syncStub, actorStub };
}

Deno.test("cli delete removes fsm.json/xstate-fsm.json but keeps implemented worker stubs by default (#377)", async () => {
  const { cwd, versionDir, syncStub, actorStub } = await setUpDeleteFixture(
    "delete-keeps-stubs",
  );
  const { code, stdout } = await runCli(
    ["-c", "delete", "-f", "fsm"],
    undefined,
    cwd,
  );
  assertEquals(code, 0);
  assertEquals(await pathExists(`${versionDir}/fsm.json`), false);
  assertEquals(await pathExists(`${versionDir}/xstate-fsm.json`), false);
  assertEquals(await Deno.readTextFile(syncStub), "// implemented by hand\n");
  assertEquals(await Deno.readTextFile(actorStub), "// implemented by hand\n");
  assertStringIncludes(stdout, "--include-workers");
});

Deno.test("cli delete --include-workers also removes that FSM version's worker folders", async () => {
  const { cwd, versionDir } = await setUpDeleteFixture(
    "delete-include-workers",
  );
  // Another FSM's worker folder must survive: removal is scoped per version.
  const otherStub = `${cwd}/sync-worker/typescript/other/v01/actions/index.ts`;
  await Deno.mkdir(otherStub.substring(0, otherStub.lastIndexOf("/")), {
    recursive: true,
  });
  await Deno.writeTextFile(otherStub, "// other fsm\n");

  const { code } = await runCli(
    ["-c", "delete", "-f", "fsm", "--include-workers"],
    undefined,
    cwd,
  );
  assertEquals(code, 0);
  assertEquals(await pathExists(`${versionDir}/fsm.json`), false);
  assertEquals(
    await pathExists(`${cwd}/sync-worker/typescript/checkout/v01`),
    false,
  );
  assertEquals(
    await pathExists(`${cwd}/async-worker/python/checkout/v01`),
    false,
  );
  assert(await pathExists(otherStub));
});

Deno.test("cli delete keeps fsm.json (and its worker folders) in a version folder with no machine.ts", async () => {
  const cwd = `${FIXTURE_ROOT}/delete-no-machine-ts`;
  const versionDir = `${cwd}/fsm/checkout/v01`;
  await Deno.mkdir(versionDir, { recursive: true });
  await copy(SINGLE_FSM_JSON, `${versionDir}/fsm.json`);
  const stubDir = `${cwd}/sync-worker/typescript/checkout/v01/actions`;
  await Deno.mkdir(stubDir, { recursive: true });
  await Deno.writeTextFile(`${stubDir}/index.ts`, "// user code\n");

  const { code } = await runCli(
    ["-c", "delete", "-f", "fsm"],
    undefined,
    cwd,
  );
  assertEquals(code, 0);
  assert(await pathExists(`${versionDir}/fsm.json`));
  assert(await pathExists(`${stubDir}/index.ts`));
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
