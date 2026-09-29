import { assert, assertEquals, assertRejects } from "@std/assert";
import { Pool } from "pg";
import type { Json } from "../src/database.types.ts";
import {
  canonicalizeFsmJson,
  extractFsmDependentChildren,
  type FsmDefinition,
  FsmDefinitionLoadError,
  fsmJsonDigest,
  getFsmJsonForFsmModules,
  loadFsmDefinitions,
} from "../src/fsm-definition.ts";

Deno.test("canonicalizeFsmJson sorts keys at every depth and drops whitespace", () => {
  assertEquals(
    canonicalizeFsmJson({ b: 1, a: { d: [3, { z: true, y: null }], c: "x" } }),
    '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}',
  );
});

Deno.test("fsmJsonDigest ignores key order and formatting", async () => {
  const a = JSON.parse('{"id":"m","states":{"s1":{"type":"atomic"}}}');
  const b = JSON.parse(
    '{\n  "states": { "s1": { "type": "atomic" } },\n  "id": "m"\n}',
  );
  assertEquals(await fsmJsonDigest(a), await fsmJsonDigest(b));
  assert(/^[0-9a-f]{64}$/.test(await fsmJsonDigest(a)));
});

Deno.test("fsmJsonDigest changes when content changes", async () => {
  assert(
    await fsmJsonDigest({ id: "m", v: 1 }) !==
      await fsmJsonDigest({ id: "m", v: 2 }),
  );
});

Deno.test("extractFsmDependentChildren finds nested fsm invokes only", () => {
  const children = extractFsmDependentChildren({
    id: "p",
    invoke: [{
      src: "a",
      asyncOperationType: "fsm",
      asyncOperationVersion: "v1",
    }],
    states: {
      s1: {
        invoke: [
          { src: "b", asyncOperationType: "fsm", asyncOperationVersion: "v2" },
          {
            src: "act",
            asyncOperationType: "internalAsyncOperation",
            asyncOperationVersion: "v1",
          },
        ],
        states: {
          s2: {
            invoke: [
              {
                src: "a",
                asyncOperationType: "fsm",
                asyncOperationVersion: "v1",
              },
            ],
          },
        },
      },
    },
  });
  assertEquals(
    children.map((c) => `${c.fsm_name}/${c.fsm_version}`).sort(),
    ["a/v1", "b/v2"],
  );
});

// --- Integration: needs a pgfsm database (DATABASE_URL), e.g. local Supabase.

const DATABASE_URL = Deno.env.get("DATABASE_URL");
const integration = { ignore: !DATABASE_URL, sanitizeResources: false };

/** A two-state machine; `invokes` adds fsm-child invokes on its first state. */
function machine(id: string, invokes: string[] = [], variant = 0): Json {
  return {
    id,
    key: id,
    type: "compound",
    order: -1,
    ...(variant ? { description: `variant ${variant}` } : {}),
    states: {
      red: {
        id: `${id}.red`,
        key: "red",
        type: "atomic",
        order: 1,
        invoke: invokes.map((src) => ({
          id: `${src}-child`,
          src,
          type: "xstate.invoke",
          asyncOperationType: "fsm",
          asyncOperationVersion: "v1",
        })),
        transitions: [{
          source: `#${id}.red`,
          target: [`#${id}.green`],
          eventType: "NEXT",
          actions: [],
        }],
      },
      green: {
        id: `${id}.green`,
        key: "green",
        type: "atomic",
        order: 2,
        transitions: [{
          source: `#${id}.green`,
          target: [`#${id}.red`],
          eventType: "NEXT",
          actions: [],
        }],
      },
    },
  } as Json;
}

async function withDb(fn: (pool: Pool, prefix: string) => Promise<void>) {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  const prefix = `spec006_${crypto.randomUUID().slice(0, 8)}_`;
  try {
    await fn(pool, prefix);
  } finally {
    for (
      const table of [
        "fsm_dependencies",
        "fsm_transitions",
        "fsm_states",
        "fsm_json",
      ]
    ) {
      const col = table === "fsm_dependencies" ? "parent_fsm_name" : "fsm_name";
      await pool.query(
        `DELETE FROM fsm_core.${table} WHERE ${col} LIKE $1`,
        [`${prefix}%`],
      );
    }
    await pool.end();
  }
}

const def = (fsmName: string, fsmJson: Json): FsmDefinition => ({
  fsmName,
  fsmVersion: "v1",
  fsmJson,
});

Deno.test(
  "loadFsmDefinitions loads children before parents",
  integration,
  () =>
    withDb(async (pool, p) => {
      const deps = { db: pool, useSupabase: false };
      // Parent first in the input: the loader must still load the child first.
      const results = await loadFsmDefinitions(deps, [
        def(`${p}parent`, machine(`${p}parent`, [`${p}child`])),
        def(`${p}child`, machine(`${p}child`)),
      ]);
      assertEquals(results.map((r) => [r.fsmName, r.status]), [
        [`${p}child`, "loaded"],
        [`${p}parent`, "loaded"],
      ]);
      const deps2 = await pool.query(
        `SELECT child_fsm_name FROM fsm_core.fsm_dependencies WHERE parent_fsm_name = $1`,
        [`${p}parent`],
      );
      assertEquals(deps2.rows.map((r) => r.child_fsm_name), [`${p}child`]);
    }),
);

Deno.test(
  "loadFsmDefinitions reports unchanged on identical re-load",
  integration,
  () =>
    withDb(async (pool, p) => {
      const deps = { db: pool, useSupabase: false };
      const defs = [def(`${p}a`, machine(`${p}a`))];
      await loadFsmDefinitions(deps, defs);
      const again = await loadFsmDefinitions(deps, defs);
      assertEquals(again.map((r) => r.status), ["unchanged"]);
    }),
);

Deno.test(
  "loadFsmDefinitions rejects a missing child and a cycle before writing",
  integration,
  () =>
    withDb(async (pool, p) => {
      const deps = { db: pool, useSupabase: false };
      const err = await assertRejects(
        () =>
          loadFsmDefinitions(deps, [
            def(`${p}orphan`, machine(`${p}orphan`, [`${p}nowhere`])),
            def(`${p}x`, machine(`${p}x`, [`${p}y`])),
            def(`${p}y`, machine(`${p}y`, [`${p}x`])),
          ]),
        FsmDefinitionLoadError,
      );
      assertEquals(err.problems.length, 2);
      assert(err.problems[0].includes(`${p}nowhere/v1`));
      assert(err.problems[1].includes("dependency cycle"));
      const rows = await getFsmJsonForFsmModules(deps, [
        { fsm_name: `${p}orphan`, fsm_version: "v1" },
        { fsm_name: `${p}x`, fsm_version: "v1" },
      ]);
      assertEquals(rows.length, 0);
    }),
);

Deno.test(
  "loadFsmDefinitions rolls the whole batch back on a failure",
  integration,
  () =>
    withDb(async (pool, p) => {
      const deps = { db: pool, useSupabase: false };
      await loadFsmDefinitions(deps, [def(`${p}fixed`, machine(`${p}fixed`))]);
      // `fixed` changed content under the same version: the load of `fresh`
      // before it in the batch must be undone too.
      await assertRejects(
        () =>
          loadFsmDefinitions(deps, [
            def(`${p}fresh`, machine(`${p}fresh`)),
            def(`${p}fixed`, machine(`${p}fixed`, [], 1)),
          ]),
        FsmDefinitionLoadError,
        "already loaded with different JSON content",
      );
      const rows = await getFsmJsonForFsmModules(deps, [
        { fsm_name: `${p}fresh`, fsm_version: "v1" },
      ]);
      assertEquals(rows.length, 0);
    }),
);

Deno.test(
  "concurrent loads of one new version leave exactly one copy",
  integration,
  () =>
    withDb(async (pool, p) => {
      const name = `${p}race`;
      const pools = Array.from(
        { length: 4 },
        () => new Pool({ connectionString: DATABASE_URL, max: 1 }),
      );
      try {
        const results = await Promise.all(
          pools.map((db) =>
            loadFsmDefinitions({ db, useSupabase: false }, [
              def(name, machine(name)),
            ])
          ),
        );
        assertEquals(
          results.flat().filter((r) => r.status === "loaded").length,
          1,
        );
      } finally {
        await Promise.all(pools.map((db) => db.end()));
      }
      const counts = await pool.query(
        `SELECT (SELECT count(*) FROM fsm_core.fsm_json WHERE fsm_name = $1)::int AS json,
              (SELECT count(*) FROM fsm_core.fsm_states WHERE fsm_name = $1)::int AS states,
              (SELECT count(*) FROM fsm_core.fsm_transitions WHERE fsm_name = $1)::int AS transitions`,
        [name],
      );
      assertEquals(counts.rows[0], { json: 1, states: 3, transitions: 2 });
    }),
);
