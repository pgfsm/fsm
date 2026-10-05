import { assertEquals, assertMatch } from "@std/assert";
import { fsmJsonDigest } from "@pgfsm/db";
import { generateSyncOperationLogicFromFsmJson } from "../src/generate-sync-operation-logic.ts";

const FIXTURE = new URL(
  "../../../apps/fsm-core-example/fsm/creditCheck/v01/fsm.json",
  import.meta.url,
);

Deno.test("generate-sync-logic writes FSM_DEFINITION with the fsm.json's canonical digest, and the aggregate lists it (SPEC-006)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const text = await Deno.readTextFile(FIXTURE);
    await generateSyncOperationLogicFromFsmJson(
      FIXTURE.pathname,
      dir,
      "creditCheck",
      "v01",
      ["typescript"],
    );
    const tsDir = `${dir}/sync-worker/typescript`;

    const registry = await Deno.readTextFile(
      `${tsDir}/creditCheck/v01/sync-operation-registry.generated.ts`,
    );
    const digest = registry.match(/fsmJsonSha256:\s*"([0-9a-f]{64})"/)?.[1];
    assertEquals(digest, await fsmJsonDigest(JSON.parse(text)));

    const aggregate = await Deno.readTextFile(
      `${tsDir}/sync-operation-registry-aggregate.generated.ts`,
    );
    assertMatch(aggregate, /FSM_DEFINITION as creditcheck_v01_definition/);
    assertMatch(
      aggregate,
      /export const FSM_DEFINITIONS = \[\s*creditcheck_v01_definition,\s*\];/,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
