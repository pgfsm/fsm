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

Deno.test("generateAll - folder mode runs generate-fsm-json, generate-async-logic, and generate-sync-logic in sequence", async () => {
  await generateAll({ folder: FSM_FOLDER });

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
  const aggregateContent = await Deno.readTextFile(
    `${APP_ROOT}/worker-sdk-generated/typescript/typescript-actors-registry.generated.ts`,
  );
  assert(aggregateContent.includes("creditcheck_v01"));
});

Deno.test("generateAll - single machine.ts file mode requires output", async () => {
  await assertRejects(
    () => generateAll({ folder: `${FSM_FOLDER}/creditCheck/v01/machine.ts` }),
    Error,
    "requires --output",
  );
});

Deno.test("generateAll - single machine.ts file mode writes fsm.json, actor stubs, sync stubs, and the aggregate registry all into output", async () => {
  const outDir = `${FIXTURE_ROOT}/generate-all-single-file/creditCheck/v01`;
  await generateAll({
    folder: `${FSM_FOLDER}/creditCheck/v01/machine.ts`,
    output: outDir,
  });

  const fsmJsonStat = await Deno.stat(`${outDir}/fsm.json`);
  assert(fsmJsonStat.isFile);
  const actorStat = await Deno.stat(
    `${outDir}/typescript/actors/verifyCredentials/verifyCredentials.ts`,
  );
  assert(actorStat.isFile);
  const aggregateStat = await Deno.stat(
    `${outDir}/worker-sdk-generated/typescript/typescript-actors-registry.generated.ts`,
  );
  assert(aggregateStat.isFile);
});

Deno.test("generateAll - single fsm.json file mode requires output", async () => {
  await assertRejects(
    () => generateAll({ folder: SINGLE_FSM_JSON }),
    Error,
    "requires --output",
  );
});

Deno.test("generateAll - single fsm.json file mode skips generate-fsm-json and writes actor + sync stubs and the aggregate registry into output", async () => {
  const outDir = `${FIXTURE_ROOT}/generate-all-fsm-json-mode`;
  await generateAll({ folder: SINGLE_FSM_JSON, output: outDir });

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
  const aggregateContent = await Deno.readTextFile(
    `${outDir}/worker-sdk-generated/typescript/typescript-actors-registry.generated.ts`,
  );
  assert(aggregateContent.includes("creditcheck_v01"));
});

Deno.test("generateAll - rejects a --folder file that's neither .ts nor .json", async () => {
  const txtPath = `${FIXTURE_ROOT}/generate-all-bad-extension.txt`;
  await Deno.writeTextFile(txtPath, "not a machine.ts or fsm.json\n");
  await assertRejects(
    () => generateAll({ folder: txtPath }),
    Error,
    "must be a .ts or fsm.json file",
  );
});

Deno.test("generateAll - rejects a nonexistent --folder", async () => {
  await assertRejects(
    () => generateAll({ folder: `${FIXTURE_ROOT}/does-not-exist` }),
    Error,
    "does not exist",
  );
});

Deno.test("cleanup fixture copy", async () => {
  await Deno.remove(FIXTURE_ROOT, { recursive: true });
});
