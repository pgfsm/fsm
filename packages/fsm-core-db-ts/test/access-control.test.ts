import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
// @ts-types="@types/pg"
import { Pool } from "pg";
import type { Json } from "../src/database.types.ts";
import type { DBDeps } from "../src/custom.types.ts";
import {
  createApiKey,
  hashApiKey,
  listApiKeys,
  revokeApiKey,
  verifyApiKey,
} from "../src/40_access_control/apiKeys.ts";
import { type FsmDbRole, withRole } from "../src/40_access_control/withRole.ts";
import { loadFsmDefinitions } from "../src/fsm-definition.ts";

Deno.test("hashApiKey is lowercase hex SHA-256", async () => {
  // sha256("abc"), from FIPS 180-2.
  assertEquals(
    await hashApiKey("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("withRole rejects a role outside the allow-list without connecting", async () => {
  let connected = false;
  const deps = {
    useSupabase: false,
    db: {
      connect: () => {
        connected = true;
        throw new Error("should not connect");
      },
    },
  } as unknown as DBDeps;
  await assertRejects(
    () =>
      withRole(
        deps,
        "postgres; DROP TABLE x" as FsmDbRole,
        () => Promise.resolve(),
      ),
    Error,
    "unknown role",
  );
  assert(!connected);
});

// --- Integration: needs a pgfsm database (DATABASE_URL) whose user is the
// schema owner, e.g. local Supabase (the owner is a member of every fsm_* role).

const DATABASE_URL = Deno.env.get("DATABASE_URL");
const integration = { ignore: !DATABASE_URL, sanitizeResources: false };

async function withDb(
  fn: (deps: DBDeps, prefix: string) => Promise<void>,
  max = 2,
) {
  const pool = new Pool({ connectionString: DATABASE_URL, max });
  const prefix = `t470_${crypto.randomUUID().slice(0, 8)}_`;
  try {
    await fn({ db: pool, useSupabase: false }, prefix);
  } finally {
    await pool.query(`DELETE FROM fsm_core.api_keys WHERE name LIKE $1`, [
      `${prefix}%`,
    ]);
    for (const table of ["fsm_transitions", "fsm_states", "fsm_json"]) {
      await pool.query(`DELETE FROM fsm_core.${table} WHERE fsm_name LIKE $1`, [
        `${prefix}%`,
      ]);
    }
    await pool.end();
  }
}

const currentUser = async (deps: DBDeps) =>
  (await deps.db.query<{ u: string }>("SELECT current_user AS u")).rows[0].u;

Deno.test(
  "withRole runs as the role, concurrently, and never leaks it to the pool",
  integration,
  () =>
    withDb(async (deps) => {
      const owner = await currentUser(deps);
      const roles: FsmDbRole[] = [
        "fsm_operator",
        "fsm_admin",
        "fsm_worker",
      ];
      // 12 interleaved calls over a 2-connection pool: every connection is
      // reused across roles.
      const seen = await Promise.all(
        Array.from({ length: 12 }, (_, i) => roles[i % 3]).map((role) =>
          withRole(deps, role, async (d) => {
            await d.db.query("SELECT pg_sleep(0.01)");
            return [role, await currentUser(d)];
          })
        ),
      );
      for (const [want, got] of seen) assertEquals(got, want);

      const after = await Promise.all([currentUser(deps), currentUser(deps)]);
      assertEquals(after, [owner, owner]);
    }),
);

Deno.test(
  "withRole rolls back on error and the connection keeps its login role",
  integration,
  () =>
    withDb(async (deps, p) => {
      const owner = await currentUser(deps);
      await assertRejects(
        () =>
          withRole(deps, "fsm_admin", async (d) => {
            await createApiKey(d, `${p}rolled-back`, "fsm_operator");
            throw new Error("boom");
          }),
        Error,
        "boom",
      );
      assertEquals(
        (await listApiKeys(deps)).filter((k) => k.name === `${p}rolled-back`),
        [],
      );
      assertEquals(await currentUser(deps), owner);
    }, 1),
);

/** A minimal two-state machine, the same shape as fsm-definition.test.ts. */
function machine(id: string): Json {
  const state = (key: string, next: string) => ({
    id: `${id}.${key}`,
    key,
    type: "atomic",
    order: key === "red" ? 1 : 2,
    transitions: [{
      source: `#${id}.${key}`,
      target: [`#${id}.${next}`],
      eventType: "NEXT",
      actions: [],
    }],
  });
  return {
    id,
    key: id,
    type: "compound",
    order: -1,
    states: { red: state("red", "green"), green: state("green", "red") },
  } as Json;
}

Deno.test(
  "loadFsmDefinitions runs inside withRole: commits as fsm_admin, denied as fsm_operator",
  integration,
  () =>
    withDb(async (deps, p) => {
      const loaded = await withRole(deps, "fsm_admin", (d) =>
        loadFsmDefinitions(d, [{
          fsmName: `${p}light`,
          fsmVersion: "v1",
          fsmJson: machine(`${p}light`),
        }]));
      assertEquals(loaded.length, 1);
      const rows = await deps.db.query(
        "SELECT 1 FROM fsm_core.fsm_json WHERE fsm_name = $1",
        [`${p}light`],
      );
      assertEquals(rows.rowCount, 1, "nested transaction committed");

      const err = await assertRejects(() =>
        withRole(deps, "fsm_operator", (d) =>
          loadFsmDefinitions(d, [{
            fsmName: `${p}denied`,
            fsmVersion: "v1",
            fsmJson: machine(`${p}denied`),
          }]))
      );
      assertMatch(String((err as Error).cause ?? err), /permission denied/);
      const denied = await deps.db.query(
        "SELECT 1 FROM fsm_core.fsm_json WHERE fsm_name = $1",
        [`${p}denied`],
      );
      assertEquals(denied.rowCount, 0);
    }),
);

Deno.test(
  "a nested COMMIT inside withRole doesn't commit the outer transaction",
  integration,
  () =>
    withDb(async (deps, p) => {
      // If loadFsmDefinitions' own BEGIN/COMMIT reached Postgres as-is, its
      // COMMIT would end withRole's transaction early and the load would
      // survive the throw below.
      await assertRejects(
        () =>
          withRole(deps, "fsm_admin", async (d) => {
            await loadFsmDefinitions(d, [{
              fsmName: `${p}outer`,
              fsmVersion: "v1",
              fsmJson: machine(`${p}outer`),
            }]);
            throw new Error("after nested commit");
          }),
        Error,
        "after nested commit",
      );
      const rows = await deps.db.query(
        "SELECT 1 FROM fsm_core.fsm_json WHERE fsm_name = $1",
        [`${p}outer`],
      );
      assertEquals(rows.rowCount, 0);
    }),
);

Deno.test(
  "API keys: create as admin, verify by hash, list without hash, revoke",
  integration,
  () =>
    withDb(async (deps, p) => {
      const created = await withRole(
        deps,
        "fsm_admin",
        (d) => createApiKey(d, `${p}ci`, "fsm_operator"),
      );
      assertMatch(created.key, /^pgfsm_op_[0-9a-f]{64}$/);
      assertEquals(created.role, "fsm_operator");
      assert(created.key.startsWith(created.prefix));

      const hash = await hashApiKey(created.key);
      assertEquals(await verifyApiKey(deps, hash), "fsm_operator");
      assertEquals(await verifyApiKey(deps, await hashApiKey("nope")), null);

      const listed = await withRole(deps, "fsm_admin", listApiKeys);
      const row = listed.find((k) => k.name === `${p}ci`);
      assert(row);
      assertEquals(row.prefix, created.prefix);
      assert(row.created_at instanceof Date);
      assert(!("key_hash" in row));

      assertEquals(
        await withRole(deps, "fsm_admin", (d) => revokeApiKey(d, created.id)),
        true,
      );
      assertEquals(
        await withRole(deps, "fsm_admin", (d) => revokeApiKey(d, `${p}ci`)),
        false,
        "already revoked",
      );
      assertEquals(await verifyApiKey(deps, hash), null);
    }),
);

Deno.test(
  "API keys: fsm_operator cannot create or list keys",
  integration,
  () =>
    withDb(async (deps, p) => {
      await assertRejects(
        () =>
          withRole(
            deps,
            "fsm_operator",
            (d) => createApiKey(d, `${p}x`, "fsm_admin"),
          ),
        Error,
        "permission denied",
      );
      await assertRejects(
        () => withRole(deps, "fsm_operator", listApiKeys),
        Error,
        "permission denied",
      );
    }),
);
