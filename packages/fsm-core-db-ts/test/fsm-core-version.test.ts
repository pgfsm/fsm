// requireFsmCoreVersion() (SPEC-016, #688): the startup check the API, fsmlet
// and gateway run. Unit tests use a fake connection; the integration test
// reads the real fsm_core.version() (DATABASE_URL, as in CI's database job).
import { assertEquals, assertRejects } from "@std/assert";
// @ts-types="@types/pg"
import pg from "pg";
import {
  FSM_CORE_MIN_VERSION,
  type FsmCoreQueryable,
  FsmCoreVersionError,
  getFsmCoreVersion,
  requireFsmCoreVersion,
} from "../src/index.ts";

/** A connection whose fsm_core is `version` (null: before 2.3.0, undefined: none). */
function fakeDb(version: string | null | undefined): FsmCoreQueryable {
  return {
    query<R>(sql: string) {
      const row = sql.includes("to_regnamespace")
        ? {
          installed: version !== undefined,
          has_version: typeof version === "string",
        }
        : { version };
      return Promise.resolve({ rows: [row as R] });
    },
  };
}

Deno.test("requireFsmCoreVersion accepts the minimum and later minor/patch versions", async () => {
  assertEquals(
    await requireFsmCoreVersion(fakeDb("2.3.0"), "test", "2.3.0"),
    "2.3.0",
  );
  assertEquals(
    await requireFsmCoreVersion(fakeDb("2.10.1"), "test", "2.3.0"),
    "2.10.1",
  );
});

Deno.test("requireFsmCoreVersion refuses an older fsm_core, naming the scripts to apply", async () => {
  const e = await assertRejects(
    () => requireFsmCoreVersion(fakeDb("2.2.9"), "pgfsm-api", "2.3.0"),
    FsmCoreVersionError,
    "pgfsm-api needs fsm_core >= 2.3.0 and < 3.0.0, found 2.2.9: apply the upgrade scripts in order, from fsm_core--2.2.9--<next>.sql up to 2.3.0",
  );
  assertEquals(e.found, "2.2.9");
});

Deno.test("requireFsmCoreVersion refuses an fsm_core from before version() existed", async () => {
  await assertRejects(
    () => requireFsmCoreVersion(fakeDb(null), "fsmlet", "2.3.0"),
    FsmCoreVersionError,
    "found a version before 2.3.0 (no fsm_core.version())",
  );
});

Deno.test("requireFsmCoreVersion refuses a newer major version", async () => {
  await assertRejects(
    () => requireFsmCoreVersion(fakeDb("3.0.0"), "gateway", "2.3.0"),
    FsmCoreVersionError,
    "found 3.0.0: upgrade gateway to a release that supports fsm_core 3.x",
  );
});

Deno.test("getFsmCoreVersion fails when fsm_core isn't installed", async () => {
  await assertRejects(
    () => getFsmCoreVersion(fakeDb(undefined)),
    FsmCoreVersionError,
    "fsm_core isn't installed in this database",
  );
});

const DATABASE_URL = Deno.env.get("DATABASE_URL");

Deno.test({
  name: "the database's fsm_core satisfies this @pgfsm/db",
  ignore: !DATABASE_URL,
  fn: async () => {
    const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    try {
      const found = await requireFsmCoreVersion(pool, "test");
      assertEquals(typeof found, "string");
      assertEquals(found >= FSM_CORE_MIN_VERSION, true);
    } finally {
      await pool.end();
    }
  },
});
