import { assertEquals, assertRejects } from "@std/assert";
// @ts-types="@types/pg"
import { Pool } from "pg";
import {
  createFsmInstanceFromName,
  fsmJsonDigest,
  getFsmDefinition,
  listFsmDefinitions,
  listFsmInstances,
  loadFsmDefinitions,
} from "../src/index.ts";
import type { Json } from "../src/database.types.ts";

// #661: server-side filters and a limit for listFsmInstances, and the read
// functions behind `pgfsmctl fsm list|get`. Needs DATABASE_URL.
const DATABASE_URL = Deno.env.get("DATABASE_URL");
const db = {
  ignore: !DATABASE_URL,
  sanitizeResources: false,
  sanitizeOps: false,
};

/** A one-state machine named `id`. */
const machine = (id: string): Json => ({
  id,
  key: id,
  type: "compound",
  order: -1,
  initial: `#${id}.idle`,
  states: {
    idle: { id: `${id}.idle`, key: "idle", type: "atomic", order: 1 },
  },
});

async function cleanup(pool: Pool, prefix: string) {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM fsm_core.fsm_instance WHERE fsm_name LIKE $1",
    [`${prefix}%`],
  );
  const ids = rows.map((r) => r.id);
  for (
    const t of [
      "fsm_instance_queue_event_logs",
      "fsm_instance_lock",
      "fsm_instance_transitions_auth",
      "fsm_instance_and_fsm_workerlet",
    ]
  ) {
    await pool.query(
      `DELETE FROM fsm_core.${t} WHERE fsm_instance_id = ANY($1::uuid[])`,
      [ids],
    );
  }
  await pool.query(
    "DELETE FROM fsm_core.fsm_instance WHERE id = ANY($1::uuid[])",
    [ids],
  );
  for (const id of ids) {
    await pool.query(
      "SELECT pgmq.drop_queue($1) FROM pgmq.meta WHERE queue_name = $1",
      [id],
    );
  }
  for (const t of ["fsm_transitions", "fsm_states", "fsm_json"]) {
    await pool.query(`DELETE FROM fsm_core.${t} WHERE fsm_name LIKE $1`, [
      `${prefix}%`,
    ]);
  }
}

Deno.test({
  name:
    "listFsmInstances filters by name, version and status, newest first, and limits (#661)",
  ...db,
  fn: async () => {
    const prefix = `t661_${crypto.randomUUID().slice(0, 8)}_`;
    const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    const deps = { db: pool, useSupabase: false };
    try {
      const [a, b] = [`${prefix}a`, `${prefix}b`];
      await loadFsmDefinitions(deps, [
        { fsmName: a, fsmVersion: "v01", fsmJson: machine(a) },
        { fsmName: a, fsmVersion: "v02", fsmJson: machine(a) },
        { fsmName: b, fsmVersion: "v01", fsmJson: machine(b) },
      ]);
      const create = async (name: string, version: string) =>
        ((await createFsmInstanceFromName(deps, name, version, {}, true)) as {
          fsm_instance_id: string;
        }).fsm_instance_id;
      const a1 = await create(a, "v01");
      const a2 = await create(a, "v01");
      const a3 = await create(a, "v02");
      const b1 = await create(b, "v01");
      // One instance in error, as SPEC-014 would leave it.
      await pool.query(
        `UPDATE fsm_core.fsm_instance SET fsm_instance_status = '"error"' WHERE id = $1`,
        [a2],
      );

      const ids = async (o: Parameters<typeof listFsmInstances>[1]) =>
        (await listFsmInstances(deps, o)).map((r) => r.id);

      assertEquals(
        new Set(await ids({ fsmName: a })),
        new Set([a1, a2, a3]),
      );
      assertEquals(
        new Set(await ids({ fsmName: a, fsmVersion: "v01" })),
        new Set([a1, a2]),
      );
      assertEquals(await ids({ fsmName: a, status: "error" }), [a2]);
      assertEquals(await ids({ fsmName: b }), [b1]);
      assertEquals(await ids({ fsmName: `${prefix}none` }), []);
      // Newest first, cut to the limit.
      const newest = await ids({ fsmName: a, limit: 2 });
      assertEquals(newest.length, 2);
      const all = await listFsmInstances(deps, { fsmName: a });
      assertEquals(newest, all.slice(0, 2).map((r) => r.id));
      for (let i = 1; i < all.length; i++) {
        assertEquals(
          all[i - 1].started_at! >= all[i].started_at!,
          true,
          "started_at descending",
        );
      }
      await assertRejects(
        () => listFsmInstances(deps, { limit: 0 }),
        RangeError,
      );
    } finally {
      await cleanup(pool, prefix);
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "listFsmDefinitions lists loaded versions with their digest; getFsmDefinition reads one (#661)",
  ...db,
  fn: async () => {
    const prefix = `t661_${crypto.randomUUID().slice(0, 8)}_`;
    const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    const deps = { db: pool, useSupabase: false };
    try {
      const [a, b] = [`${prefix}a`, `${prefix}b`];
      await loadFsmDefinitions(deps, [
        { fsmName: a, fsmVersion: "v01", fsmJson: machine(a) },
        { fsmName: a, fsmVersion: "v02", fsmJson: machine(a) },
        { fsmName: b, fsmVersion: "v01", fsmJson: machine(b) },
      ]);
      const ours = (await listFsmDefinitions(deps)).filter((d) =>
        d.fsm_name.startsWith(prefix)
      );
      assertEquals(
        ours.map((d) => `${d.fsm_name}/${d.fsm_version}`),
        [`${a}/v01`, `${a}/v02`, `${b}/v01`],
      );
      assertEquals(ours[0].fsm_json_sha256, await fsmJsonDigest(machine(a)));

      assertEquals(
        (await listFsmDefinitions(deps, { fsmName: a, fsmVersion: "v02" }))
          .map((d) => d.fsm_version),
        ["v02"],
      );

      const one = await getFsmDefinition(deps, b, "v01");
      assertEquals(one?.fsm_json, machine(b));
      assertEquals(await getFsmDefinition(deps, b, "v09"), undefined);
    } finally {
      await cleanup(pool, prefix);
      await pool.end();
    }
  },
});
