// SPEC-016 (#689): GET/POST /admin/scheduler, and `pgfsm-api key bootstrap`.
// Needs a pgfsm database whose DATABASE_URL user is the schema owner (a member
// of every fsm_* role), e.g. local Supabase; skipped otherwise.
import { assert, assertEquals, assertRejects } from "@std/assert";
// @ts-types="@types/pg"
import { Pool } from "pg";
import { createApiKey, registerSchedulerJob } from "@pgfsm/db";

import { createRouter } from "../lib/create-router.ts";
import { apiKeyAuth } from "../middlewares/api-key-auth.ts";
import admin from "../routes/admin/admin.index.ts";
import {
  bootstrapAdminKey,
  KeyBootstrapError,
} from "../src/cli/key-bootstrap.ts";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
const integration = { ignore: !DATABASE_URL, sanitizeResources: false };

async function withDb(
  fn: (pool: Pool, prefix: string) => Promise<void>,
) {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
  const prefix = `t689_${crypto.randomUUID().slice(0, 8)}_`;
  try {
    await fn(pool, prefix);
  } finally {
    await pool.query("DELETE FROM fsm_core.api_keys WHERE name LIKE $1", [
      `${prefix}%`,
    ]);
    await pool.end();
  }
}

function adminApp(pool: Pool) {
  const app = createRouter();
  app.use(
    "/admin/*",
    apiKeyAuth({ pool, requiredRole: "fsm_admin", cacheTtlMs: 0 }),
  );
  app.route("/", admin);
  return app;
}

const json = (body: unknown, key: string) => ({
  method: "POST",
  headers: {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(body),
});

Deno.test(
  "GET/POST /admin/scheduler report and (re)register the pg_cron job",
  integration,
  () =>
    withDb(async (pool, prefix) => {
      const deps = { db: pool, useSupabase: false };
      const adminKey =
        (await createApiKey(deps, `${prefix}admin`, "fsm_admin")).key;
      const operatorKey =
        (await createApiKey(deps, `${prefix}op`, "fsm_operator")).key;
      const app = adminApp(pool);
      const auth = { headers: { authorization: `Bearer ${adminKey}` } };
      try {
        const got = await app.request("/admin/scheduler", auth);
        assertEquals(got.status, 200);
        const status = (await got.json()).data;
        assertEquals(status.jobname, "fsm_schedule_all_pending");
        assertEquals(status.registered, true);

        const changed = await app.request(
          "/admin/scheduler",
          json({ schedule: "9 seconds" }, adminKey),
        );
        assertEquals(changed.status, 200);
        assertEquals((await changed.json()).data.schedule, "9 seconds");
        const { rows } = await pool.query(
          "SELECT count(*)::int AS n FROM cron.job WHERE jobname = 'fsm_schedule_all_pending'",
        );
        assertEquals(rows[0].n, 1, "re-registering replaces the job");

        const bad = await app.request(
          "/admin/scheduler",
          json({ schedule: "bogus" }, adminKey),
        );
        assertEquals(bad.status, 422);
        assert((await bad.json()).message.includes("schedule"));

        const empty = await app.request("/admin/scheduler", {
          method: "POST",
          headers: { authorization: `Bearer ${adminKey}` },
        });
        assertEquals(empty.status, 200);
        assertEquals(
          (await empty.json()).data.schedule,
          "5 seconds",
          "no body: the default",
        );

        const forbidden = await app.request("/admin/scheduler", {
          headers: { authorization: `Bearer ${operatorKey}` },
        });
        assertEquals(forbidden.status, 403);
        await forbidden.body?.cancel();
      } finally {
        await registerSchedulerJob(deps);
      }
    }),
);

Deno.test(
  "key bootstrap refuses while an admin key exists, unless --force",
  integration,
  () =>
    withDb(async (pool, prefix) => {
      // Make sure one exists, whatever else the database holds.
      await createApiKey(
        { db: pool, useSupabase: false },
        `${prefix}existing`,
        "fsm_admin",
      );
      await assertRejects(
        () => bootstrapAdminKey(pool, { name: `${prefix}boot` }),
        KeyBootstrapError,
        "an admin key already exists",
      );
      const key = await bootstrapAdminKey(pool, {
        name: `${prefix}boot`,
        force: true,
      });
      assertEquals(key.role, "fsm_admin");
      assert(key.key.startsWith("pgfsm_admin_"));
      await assertRejects(
        () => bootstrapAdminKey(pool, { name: `${prefix}boot`, force: true }),
        KeyBootstrapError,
        "pass --name <another name>",
      );
    }),
);

Deno.test(
  "key bootstrap needs a login that can act as fsm_admin",
  integration,
  () =>
    withDb(async (pool, prefix) => {
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
          () => bootstrapAdminKey(limited, { name: `${prefix}x`, force: true }),
          KeyBootstrapError,
          `GRANT fsm_admin TO ${login}`,
        );
      } finally {
        await limited.end();
        await pool.query(`DROP ROLE ${login}`);
      }
    }),
);
