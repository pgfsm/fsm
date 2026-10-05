import { assert, assertEquals, assertRejects } from "@std/assert";
import { copy } from "@std/fs/copy";
import { generateAll } from "../src/generate-all.ts";
import { makeWorkspaceTempDir } from "./test-helpers.ts";

// Exercises generateAll() as a direct library call (no CLI subprocess) — the
// npm/npx-consumer-facing entry point the CLI itself now delegates to (see
// src/cli/index.ts's "generate-all" case). CLI-level flag parsing/validation
// for generate-all is covered separately in cli.test.ts.
const FIXTURE_ROOT = await makeWorkspaceTempDir("generate-all");
const APP_ROOT = `${FIXTURE_ROOT}/fsm-core-example`;
await copy("apps/fsm-core-example", APP_ROOT);
const FSM_FOLDER = `${APP_ROOT}/fsm`;
const SINGLE_FSM_JSON = `${FSM_FOLDER}/creditCheck/v01/fsm.json`;

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("generateAll - folder mode runs generate-fsm-json, generate-async-logic, and generate-sync-logic in sequence", async () => {
  await generateAll({ folder: FSM_FOLDER, writeRootAbsPath: APP_ROOT });

  const fsmJsonStat = await Deno.stat(`${FSM_FOLDER}/creditCheck/v01/fsm.json`);
  assert(fsmJsonStat.isFile);
  // async-worker/ and sync-worker/ land under writeRootAbsPath (#372).
  const actorStat = await Deno.stat(
    `${APP_ROOT}/async-worker/typescript/creditCheck/v01/actors/verifyCredentials/verifyCredentials.ts`,
  );
  assert(actorStat.isFile);
  const syncStat = await Deno.stat(
    `${APP_ROOT}/sync-worker/typescript/creditCheck/v01/actions/assignSSN/assignSSN.ts`,
  );
  assert(syncStat.isFile);
  const registryStat = await Deno.stat(
    `${APP_ROOT}/sync-worker/typescript/creditCheck/v01/generated-sync-operation-registry.ts`,
  );
  assert(registryStat.isFile);
  const aggregateContent = await Deno.readTextFile(
    `${APP_ROOT}/async-worker/typescript/typescript-actors-registry.generated.ts`,
  );
  assert(aggregateContent.includes("creditcheck_v01"));
});

Deno.test("generateAll - single machine.ts file mode writes fsm.json to <writeRoot>/fsm/<N>/<V>/ and stubs + aggregate under writeRootAbsPath", async () => {
  const versionDir = `${FIXTURE_ROOT}/single-machine/fsm/checkout/v02`;
  await Deno.mkdir(versionDir, { recursive: true });
  await copy(
    `${FSM_FOLDER}/creditCheck/v01/machine.ts`,
    `${versionDir}/machine.ts`,
  );
  const writeRoot = `${FIXTURE_ROOT}/single-machine/app`;
  await generateAll({
    folder: `${versionDir}/machine.ts`,
    writeRootAbsPath: writeRoot,
    fsmName: "checkout",
    fsmVersion: "v02",
  });

  assert(await pathExists(`${writeRoot}/fsm/checkout/v02/fsm.json`));
  assert(await pathExists(`${writeRoot}/fsm/checkout/v02/xstate-fsm.json`));
  assertEquals(
    await pathExists(`${writeRoot}/fsm/checkout/v02/machine.ts`),
    false,
  );
  assert(
    await pathExists(
      `${writeRoot}/async-worker/typescript/checkout/v02/actors/verifyCredentials/verifyCredentials.ts`,
    ),
  );
  assert(
    await pathExists(
      `${writeRoot}/sync-worker/typescript/checkout/v02/actions/assignSSN/assignSSN.ts`,
    ),
  );
  assert(
    await pathExists(
      `${writeRoot}/async-worker/typescript/typescript-actors-registry.generated.ts`,
    ),
  );
});

Deno.test("generateAll - single fsm.json file mode skips generate-fsm-json and writes actor + sync stubs and the aggregate registry under writeRootAbsPath", async () => {
  const writeRoot = `${FIXTURE_ROOT}/generate-all-fsm-json-mode`;
  await generateAll({
    folder: SINGLE_FSM_JSON,
    writeRootAbsPath: writeRoot,
    fsmName: "creditCheck",
    fsmVersion: "v01",
  });

  assertEquals(await pathExists(`${writeRoot}/fsm.json`), false);
  assert(await pathExists(`${writeRoot}/fsm/creditCheck/v01/fsm.json`));

  const actorStat = await Deno.stat(
    `${writeRoot}/async-worker/typescript/creditCheck/v01/actors/verifyCredentials/verifyCredentials.ts`,
  );
  assert(actorStat.isFile);
  const aggregateContent = await Deno.readTextFile(
    `${writeRoot}/async-worker/typescript/typescript-actors-registry.generated.ts`,
  );
  assert(aggregateContent.includes("creditcheck_v01"));
});

for (
  const file of [SINGLE_FSM_JSON, `${FSM_FOLDER}/creditCheck/v01/machine.ts`]
) {
  Deno.test(
    `generateAll - single-file mode requires fsmName and fsmVersion (${
      file.split("/").at(-1)
    })`,
    async () => {
      const writeRoot = `${FIXTURE_ROOT}/generate-all-missing-identity`;
      for (
        const identity of [{}, { fsmName: "creditCheck" }, {
          fsmVersion: "v01",
        }]
      ) {
        await assertRejects(
          () =>
            generateAll({
              folder: file,
              writeRootAbsPath: writeRoot,
              ...identity,
            }),
          Error,
          "requires --fsm-name and --fsm-version",
        );
      }
      assertEquals(await pathExists(writeRoot), false);
    },
  );
}

Deno.test("generateAll - single fsm.json file mode uses the given fsmName/fsmVersion, not the file's own folders", async () => {
  const writeRoot = `${FIXTURE_ROOT}/generate-all-explicit-identity`;
  await generateAll({
    folder: SINGLE_FSM_JSON,
    writeRootAbsPath: writeRoot,
    fsmName: "checkout",
    fsmVersion: "v03",
  });
  assert(
    await pathExists(
      `${writeRoot}/async-worker/typescript/checkout/v03/actors/verifyCredentials/verifyCredentials.ts`,
    ),
  );
  assert(
    await pathExists(
      `${writeRoot}/sync-worker/typescript/checkout/v03/actions/assignSSN/assignSSN.ts`,
    ),
  );
});

Deno.test("generateAll - rejects a --folder file that's neither .ts nor .json", async () => {
  const txtPath = `${FIXTURE_ROOT}/generate-all-bad-extension.txt`;
  await Deno.writeTextFile(txtPath, "not a machine.ts or fsm.json\n");
  await assertRejects(
    () => generateAll({ folder: txtPath, writeRootAbsPath: FIXTURE_ROOT }),
    Error,
    "must be a .ts or fsm.json file",
  );
});

Deno.test("generateAll - rejects a nonexistent --folder", async () => {
  await assertRejects(
    () =>
      generateAll({
        folder: `${FIXTURE_ROOT}/does-not-exist`,
        writeRootAbsPath: FIXTURE_ROOT,
      }),
    Error,
    "does not exist",
  );
});

Deno.test("cleanup fixture copy", async () => {
  await Deno.remove(FIXTURE_ROOT, { recursive: true });
});
