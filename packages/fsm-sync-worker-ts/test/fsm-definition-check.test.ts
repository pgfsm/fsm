import { assert, assertEquals, assertRejects } from "@std/assert";
// @ts-types="@types/pg"
import { Pool } from "pg";
import {
  type FsmDefinitionDigest,
  fsmJsonDigest,
  loadFsmDefinitions,
} from "@pgfsm/db";
import type { Json } from "@pgfsm/db/database.types";
import {
  classifyFsmDefinitions,
  FsmDefinitionCheckError,
} from "../src/fsmlet/fsm-definition-check.ts";
import { startFsmlet } from "../src/fsmlet/fsmlet.ts";
import type { SyncOperationRegistration } from "../src/fsmlet/type.ts";

const mod = (fsm_name: string) => ({ fsm_name, fsm_version: "v1" });
const row = (fsm_name: string, fsm_json: Json) => ({
  fsm_name,
  fsm_version: "v1",
  fsm_json,
});

const digest = async (fsmName: string, json: Json) => ({
  fsmName,
  fsmVersion: "v1",
  fsmJsonSha256: await fsmJsonDigest(json),
});

Deno.test("classifyFsmDefinitions: ok, missing and ambiguous", async () => {
  const problems = await classifyFsmDefinitions(
    [mod("ok"), mod("gone"), mod("twice"), mod("sameTwice")],
    [
      row("ok", { id: "ok" }),
      row("twice", { id: "a" }),
      row("twice", { id: "b" }),
      // Identical duplicates (key order aside) aren't ambiguous.
      row("sameTwice", { id: "s", x: 1 }),
      row("sameTwice", { x: 1, id: "s" }),
    ],
    [
      await digest("ok", { id: "ok" }),
      await digest("gone", { id: "gone" }),
      await digest("twice", { id: "a" }),
      await digest("sameTwice", { x: 1, id: "s" }),
    ],
  );
  assertEquals(problems.map((p) => [p.fsm_name, p.reason]), [
    ["gone", "missing"],
    ["twice", "ambiguous"],
  ]);
});

Deno.test("classifyFsmDefinitions: drifted, and undigested when no digest is compiled in", async () => {
  const loaded = { id: "m", states: { a: { type: "atomic" } } };
  const compiledSame = await fsmJsonDigest(
    JSON.parse('{ "states": {"a": {"type": "atomic"}}, "id": "m" }'),
  );
  const compiledOther = await fsmJsonDigest({ id: "m" });
  const problems = await classifyFsmDefinitions(
    [mod("same"), mod("other"), mod("unknown")],
    [row("same", loaded), row("other", loaded), row("unknown", loaded)],
    [
      { fsmName: "same", fsmVersion: "v1", fsmJsonSha256: compiledSame },
      { fsmName: "other", fsmVersion: "v1", fsmJsonSha256: compiledOther },
    ],
  );
  assertEquals(problems.map((p) => [p.fsm_name, p.reason]), [
    ["other", "drifted"],
    ["unknown", "undigested"],
  ]);
});

Deno.test("startFsmlet requires fsmDefinitions before opening a connection", async () => {
  await assertRejects(
    () =>
      startFsmlet(
        // Unreachable on purpose: the guard must throw before connecting.
        { connectionString: "postgresql://nobody@127.0.0.1:1/none" },
        [{
          fsmName: "m",
          fsmVersion: "v1",
          syncOperationType: "action",
          syncOperationName: "noop",
          syncOperationLanguage: "typescript",
          handler: () => undefined,
        }],
        // A 0.2-style call: options where fsmDefinitions now goes.
        {} as unknown as FsmDefinitionDigest[],
      ),
    TypeError,
    "the third argument, fsmDefinitions, is required",
  );
});

// --- Integration: needs a pgfsm database (DATABASE_URL), e.g. local Supabase.

const DATABASE_URL = Deno.env.get("DATABASE_URL");
const integration = { ignore: !DATABASE_URL, sanitizeResources: false };

const registration = (fsmName: string): SyncOperationRegistration => ({
  fsmName,
  fsmVersion: "v1",
  syncOperationType: "action",
  syncOperationName: "noop",
  syncOperationLanguage: "typescript",
  handler: () => undefined,
});

const machine = (id: string): Json => ({
  id,
  key: id,
  type: "atomic",
  order: -1,
});

Deno.test(
  "startFsmlet refuses to register when a served FSM isn't loaded",
  integration,
  async () => {
    const name = `spec006_missing_${crypto.randomUUID().slice(0, 8)}`;
    const fsmletId = crypto.randomUUID();
    const err = await assertRejects(
      () =>
        startFsmlet(
          { connectionString: DATABASE_URL! },
          [registration(name)],
          [],
          { fsmletId },
        ),
      FsmDefinitionCheckError,
    );
    assert(err.message.includes(`${name}/v1: missing`));
    assert(err.message.includes("pgfsmctl fsm load"));

    const pool = new Pool({ connectionString: DATABASE_URL });
    try {
      const res = await pool.query(
        "SELECT count(*)::int AS n FROM fsm_core.fsm_workerlet WHERE fsm_workerlet_pid = $1",
        [fsmletId],
      );
      assertEquals(res.rows[0].n, 0);
    } finally {
      await pool.end();
    }
  },
);

Deno.test(
  "startFsmlet refuses a drifted definition when fsmDefinitions is given",
  integration,
  async () => {
    const name = `spec006_drift_${crypto.randomUUID().slice(0, 8)}`;
    const pool = new Pool({ connectionString: DATABASE_URL });
    try {
      await loadFsmDefinitions({ db: pool, useSupabase: false }, [
        { fsmName: name, fsmVersion: "v1", fsmJson: machine(name) },
      ]);
      const fsmJsonSha256 = await fsmJsonDigest({
        ...machine(name) as object,
        description: "edited",
      });
      await assertRejects(
        () =>
          startFsmlet(
            { connectionString: DATABASE_URL! },
            [registration(name)],
            [{ fsmName: name, fsmVersion: "v1", fsmJsonSha256 }],
          ),
        FsmDefinitionCheckError,
        `${name}/v1: drifted`,
      );
    } finally {
      await pool.query(
        "DELETE FROM fsm_core.fsm_states WHERE fsm_name = $1",
        [name],
      );
      await pool.query("DELETE FROM fsm_core.fsm_json WHERE fsm_name = $1", [
        name,
      ]);
      await pool.end();
    }
  },
);

Deno.test(
  "startFsmlet registers when its definitions are loaded and match",
  integration,
  async () => {
    const name = `spec006_ok_${crypto.randomUUID().slice(0, 8)}`;
    const pool = new Pool({ connectionString: DATABASE_URL });
    const controller = new AbortController();
    try {
      await loadFsmDefinitions({ db: pool, useSupabase: false }, [
        { fsmName: name, fsmVersion: "v1", fsmJson: machine(name) },
      ]);
      const handle = await startFsmlet(
        { connectionString: DATABASE_URL! },
        [registration(name)],
        [{
          fsmName: name,
          fsmVersion: "v1",
          fsmJsonSha256: await fsmJsonDigest(machine(name)),
        }],
        { signal: controller.signal },
      );
      assertEquals(handle.registeredFsmModules, [mod(name)]);
      controller.abort();
      await handle.daemon;
      await handle.pool?.end();
    } finally {
      await pool.query(
        "DELETE FROM fsm_core.fsm_states WHERE fsm_name = $1",
        [name],
      );
      await pool.query("DELETE FROM fsm_core.fsm_json WHERE fsm_name = $1", [
        name,
      ]);
      await pool.end();
    }
  },
);
