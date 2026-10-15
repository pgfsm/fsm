// SPEC-009 §3: API-key auth middleware, per-request role, admin routes.
// Needs a pgfsm database whose DATABASE_URL user is the schema owner (a member
// of every fsm_* role), e.g. local Supabase; skipped otherwise.
import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
// @ts-types="@types/pg"
import { Pool } from "pg";
import { createApiKey, type Json, revokeApiKey } from "@pgfsm/db";

import { createRouter } from "../lib/create-router.ts";
import { apiKeyAuth } from "../middlewares/api-key-auth.ts";
import admin from "../routes/admin/admin.index.ts";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
const integration = { ignore: !DATABASE_URL, sanitizeResources: false };

type Ctx = {
  pool: Pool;
  prefix: string;
  key: (role: "fsm_admin" | "fsm_operator") => Promise<string>;
};

async function withDb(fn: (ctx: Ctx) => Promise<void>) {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
  const prefix = `t472_${crypto.randomUUID().slice(0, 8)}_`;
  let n = 0;
  const key = async (role: "fsm_admin" | "fsm_operator") =>
    (await createApiKey(
      { db: pool, useSupabase: false },
      `${prefix}${role}_${n++}`,
      role,
    )).key;
  try {
    await fn({ pool, prefix, key });
  } finally {
    await pool.query("DELETE FROM fsm_core.api_keys WHERE name LIKE $1", [
      `${prefix}%`,
    ]);
    for (const t of ["fsm_transitions", "fsm_states", "fsm_json"]) {
      await pool.query(`DELETE FROM fsm_core.${t} WHERE fsm_name LIKE $1`, [
        `${prefix}%`,
      ]);
    }
    await pool.end();
  }
}

/** A tiny app: operator routes under /fsm, admin routes under /admin. */
function testApp(pool: Pool, cacheTtlMs = 0) {
  const app = createRouter();
  app.use(
    "/fsm/*",
    apiKeyAuth({ pool, requiredRole: "fsm_operator", cacheTtlMs }),
  );
  app.use(
    "/admin/*",
    apiKeyAuth({ pool, requiredRole: "fsm_admin", cacheTtlMs }),
  );
  app.get("/fsm/whoami", async (c) => {
    const { rows } = await c.get("db").query<{ u: string }>(
      "SELECT current_user AS u",
    );
    return c.json({ user: rows[0].u, role: c.get("role") });
  });
  app.post("/admin/create-then-throw", async (c) => {
    await createApiKey(
      { db: c.get("db"), useSupabase: false },
      c.req.query("name")!,
      "fsm_operator",
    );
    throw new Error("boom");
  });
  app.post("/admin/create-then-500", async (c) => {
    await createApiKey(
      { db: c.get("db"), useSupabase: false },
      c.req.query("name")!,
      "fsm_operator",
    );
    return c.json({ message: "failed" }, 500);
  });
  app.onError((err, c) => c.json({ message: err.message }, 500));
  app.route("/", admin);
  return app;
}

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

const keyExists = async (pool: Pool, name: string) =>
  (await pool.query("SELECT 1 FROM fsm_core.api_keys WHERE name = $1", [name]))
    .rowCount === 1;

Deno.test(
  "auth: missing, malformed and unknown keys get 401",
  integration,
  () =>
    withDb(async ({ pool }) => {
      const app = testApp(pool);
      assertEquals((await app.request("/fsm/whoami")).status, 401);
      assertEquals(
        (await app.request("/fsm/whoami", {
          headers: { Authorization: "Basic abc" },
        })).status,
        401,
      );
      assertEquals(
        (await app.request("/fsm/whoami", { headers: bearer("pgfsm_op_nope") }))
          .status,
        401,
      );
    }),
);

Deno.test(
  "auth: requests run as the key's role; admin keys pass operator routes",
  integration,
  () =>
    withDb(async ({ pool, key }) => {
      const app = testApp(pool);
      const op = await key("fsm_operator");
      const adm = await key("fsm_admin");
      const whoami = async (k: string) =>
        (await app.request("/fsm/whoami", { headers: bearer(k) })).json();
      const [a, b] = await Promise.all([whoami(op), whoami(adm)]);
      assertEquals(a, { user: "fsm_operator", role: "fsm_operator" });
      assertEquals(b, { user: "fsm_admin", role: "fsm_admin" });
    }),
);

Deno.test(
  "auth: an operator key on an admin route gets 403",
  integration,
  () =>
    withDb(async ({ pool, key }) => {
      const res = await testApp(pool).request("/admin/keys", {
        headers: bearer(await key("fsm_operator")),
      });
      assertEquals(res.status, 403);
    }),
);

Deno.test(
  "auth: a revoked key stops working, after at most the cache TTL",
  integration,
  () =>
    withDb(async ({ pool, key }) => {
      const op = await key("fsm_operator");
      const uncached = testApp(pool, 0);
      const cached = testApp(pool, 300);
      assertEquals(
        (await cached.request("/fsm/whoami", { headers: bearer(op) })).status,
        200,
      );

      const ids = await pool.query<{ id: string }>(
        "SELECT id FROM fsm_core.api_keys WHERE prefix = $1",
        [op.slice(0, "pgfsm_op_".length + 8)],
      );
      await revokeApiKey({ db: pool, useSupabase: false }, ids.rows[0].id);

      assertEquals(
        (await uncached.request("/fsm/whoami", { headers: bearer(op) })).status,
        401,
      );
      assertEquals(
        (await cached.request("/fsm/whoami", { headers: bearer(op) })).status,
        200,
        "still cached",
      );
      await new Promise((r) => setTimeout(r, 350));
      assertEquals(
        (await cached.request("/fsm/whoami", { headers: bearer(op) })).status,
        401,
      );
    }),
);

Deno.test(
  "auth: a handler that throws or answers 5xx rolls its writes back",
  integration,
  () =>
    withDb(async ({ pool, prefix, key }) => {
      const app = testApp(pool);
      const adm = await key("fsm_admin");
      const thrown = await app.request(
        `/admin/create-then-throw?name=${prefix}thrown`,
        {
          method: "POST",
          headers: bearer(adm),
        },
      );
      assertEquals(thrown.status, 500);
      assert(!(await keyExists(pool, `${prefix}thrown`)));

      const failed = await app.request(
        `/admin/create-then-500?name=${prefix}failed`,
        {
          method: "POST",
          headers: bearer(adm),
        },
      );
      assertEquals(failed.status, 500);
      assert(!(await keyExists(pool, `${prefix}failed`)));
    }),
);

Deno.test(
  "admin: create (201, 409 on duplicate), list, revoke (200 then 404)",
  integration,
  () =>
    withDb(async ({ pool, prefix, key }) => {
      const app = testApp(pool);
      const h = {
        ...bearer(await key("fsm_admin")),
        "Content-Type": "application/json",
      };
      const body = JSON.stringify({
        name: `${prefix}ci`,
        role: "fsm_operator",
      });

      const created = await app.request("/admin/keys", {
        method: "POST",
        headers: h,
        body,
      });
      assertEquals(created.status, 201);
      const { data } = await created.json();
      assertMatch(data.key, /^pgfsm_op_[0-9a-f]{64}$/);

      const dup = await app.request("/admin/keys", {
        method: "POST",
        headers: h,
        body,
      });
      assertEquals(dup.status, 409);

      const listed = await (await app.request("/admin/keys", { headers: h }))
        .json();
      const row = listed.data.find((k: { name: string }) =>
        k.name === `${prefix}ci`
      );
      assertEquals(row.prefix, data.prefix);
      assert(!("key_hash" in row));

      // The new key works on operator routes, until it's revoked.
      assertEquals(
        (await app.request("/fsm/whoami", { headers: bearer(data.key) }))
          .status,
        200,
      );
      const del = `/admin/keys/${encodeURIComponent(`${prefix}ci`)}`;
      assertEquals(
        (await app.request(del, { method: "DELETE", headers: h })).status,
        200,
      );
      assertEquals(
        (await app.request(del, { method: "DELETE", headers: h })).status,
        404,
      );
      assertEquals(
        (await app.request("/fsm/whoami", { headers: bearer(data.key) }))
          .status,
        401,
      );
    }),
);

/** A minimal two-state machine (same shape as @pgfsm/db's tests). */
function machine(id: string, invokes: string[] = []): Json {
  const state = (k: string, next: string, order: number) => ({
    id: `${id}.${k}`,
    key: k,
    type: "atomic",
    order,
    invoke: k === "red"
      ? invokes.map((src) => ({
        id: `${src}-child`,
        src,
        type: "xstate.invoke",
        asyncOperationType: "fsm",
        asyncOperationVersion: "v1",
      }))
      : [],
    transitions: [{
      source: `#${id}.${k}`,
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
    states: { red: state("red", "green", 1), green: state("green", "red", 2) },
  } as Json;
}

Deno.test(
  "admin: POST /admin/fsm/load loads (200), rejects a missing child (422)",
  integration,
  () =>
    withDb(async ({ pool, prefix, key }) => {
      const app = testApp(pool);
      const h = {
        ...bearer(await key("fsm_admin")),
        "Content-Type": "application/json",
      };
      const load = (definitions: unknown[]) =>
        app.request("/admin/fsm/load", {
          method: "POST",
          headers: h,
          body: JSON.stringify({ definitions }),
        });

      const ok = await load([{
        fsmName: `${prefix}light`,
        fsmVersion: "v1",
        fsmJson: machine(`${prefix}light`),
      }]);
      assertEquals(ok.status, 200);
      assertEquals((await ok.json()).data, [{
        fsmName: `${prefix}light`,
        fsmVersion: "v1",
        status: "loaded",
      }]);

      const bad = await load([{
        fsmName: `${prefix}parent`,
        fsmVersion: "v1",
        fsmJson: machine(`${prefix}parent`, [`${prefix}missing`]),
      }]);
      assertEquals(bad.status, 422);
      assert((await bad.json()).problems.length > 0);
    }),
);

// --- createApp (reads env.ts, so set what it requires before importing) ---

async function importCreateApp() {
  for (
    const [k, v] of Object.entries({
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SERVICE_ROLE_KEY: "test",
      SUPABASE_ANON_KEY: "test",
      DATABASE_URL: DATABASE_URL!,
      DB_TYPE: "postgres",
    })
  ) if (!Deno.env.get(k)) Deno.env.set(k, v);
  return (await import("../lib/create-app.ts")).default;
}

Deno.test(
  "createApp: admin API on needs a login that can act as fsm_admin",
  integration,
  () =>
    withDb(async ({ pool, prefix }) => {
      const createApp = await importCreateApp();
      const login = `${prefix}noadmin`;
      await pool.query(
        `CREATE ROLE ${login} LOGIN PASSWORD 'pw' IN ROLE fsm_operator`,
      );
      const url = new URL(DATABASE_URL!);
      url.username = login;
      url.password = "pw";
      const limited = new Pool({ connectionString: url.toString(), max: 1 });
      try {
        await assertRejects(
          () =>
            createApp("/fsm", { pool: limited, auth: true, adminApi: true }),
          Error,
          `GRANT fsm_admin TO ${login}`,
        );
      } finally {
        await limited.end();
        await pool.query(`DROP ROLE ${login}`);
      }
    }),
);

Deno.test(
  "createApp: auth on, admin on, end to end through the real app",
  integration,
  () =>
    withDb(async ({ pool, key }) => {
      const createApp = await importCreateApp();
      const app = await createApp("/fsm", {
        pool,
        auth: true,
        adminApi: true,
        authCacheTtlMs: 0,
      });
      const adm = await key("fsm_admin");
      const op = await key("fsm_operator");

      assertEquals((await app.request("/fsm")).status, 401);
      assertEquals(
        (await app.request("/fsm", { headers: bearer(op) })).status,
        200,
      );
      assertEquals(
        (await app.request("/admin/keys", { headers: bearer(op) })).status,
        403,
      );
      assertEquals(
        (await app.request("/admin/keys", { headers: bearer(adm) })).status,
        200,
      );

      const noAdmin = await createApp("/fsm", {
        pool,
        auth: true,
        adminApi: false,
        authCacheTtlMs: 0,
      });
      assertEquals(
        (await noAdmin.request("/admin/keys", { headers: bearer(adm) })).status,
        404,
        "admin routes aren't mounted",
      );
      assertEquals(
        (await noAdmin.request("/fsm", { headers: bearer(adm) })).status,
        200,
      );
    }),
);

Deno.test(
  "operator key: create, read and stop an instance through the real routes",
  integration,
  () =>
    withDb(async ({ pool, prefix, key }) => {
      const createApp = await importCreateApp();
      const app = await createApp("/fsm", {
        pool,
        auth: true,
        adminApi: true,
        authCacheTtlMs: 0,
      });
      const json = { "Content-Type": "application/json" };
      const adm = { ...bearer(await key("fsm_admin")), ...json };
      const op = { ...bearer(await key("fsm_operator")), ...json };
      const fsmName = `${prefix}light`;

      const loaded = await app.request("/admin/fsm/load", {
        method: "POST",
        headers: adm,
        body: JSON.stringify({
          definitions: [{
            fsmName,
            fsmVersion: "v1",
            fsmJson: machine(fsmName),
          }],
        }),
      });
      assertEquals(loaded.status, 200);

      let instanceId: string | undefined;
      try {
        const created = await app.request("/fsm", {
          method: "POST",
          headers: op,
          body: JSON.stringify({ fsm_name: fsmName, fsm_version: "v1" }),
        });
        assertEquals(created.status, 200);
        instanceId = (await created.json()).data.fsm_instance.fsm_instance_id;
        assert(instanceId);

        const got = await app.request(`/fsm/${instanceId}`, { headers: op });
        assertEquals(got.status, 200);

        const stopped = await app.request("/fsm/stop", {
          method: "POST",
          headers: op,
          body: JSON.stringify({ queue: instanceId }),
        });
        assertEquals(stopped.status, 200);
      } finally {
        if (instanceId) await dropInstance(pool, instanceId);
      }
    }),
);

/** Removes an instance the operator test created, with its queue and logs. */
async function dropInstance(pool: Pool, id: string) {
  await pool.query(
    "SELECT pgmq.drop_queue(queue_name) FROM pgmq.list_queues() WHERE queue_name = $1",
    [id],
  );
  for (
    const t of [
      "fsm_instance_queue_event_logs",
      "fsm_instance_and_fsm_workerlet",
      "fsm_instance_lock",
      "fsm_instance_transitions_auth",
    ]
  ) {
    await pool.query(`DELETE FROM fsm_core.${t} WHERE fsm_instance_id = $1`, [
      id,
    ]);
  }
  await pool.query("DELETE FROM fsm_core.fsm_instance WHERE id = $1", [id]);
}
