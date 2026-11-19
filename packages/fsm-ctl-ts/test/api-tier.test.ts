import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
// Test-only: pgfsmctl itself imports neither (SPEC-016, cli.test.ts checks).
// @ts-types="@types/pg"
import { Pool } from "pg";
import { createApiKey } from "@pgfsm/db";

// pgfsmctl against the real API (SPEC-009 §4–5, SPEC-016): `key …`,
// `fsm …`, `instance …` and `scheduler …`. Argument tests need nothing; the
// rest start the API (packages/fsm-api-ts) as a subprocess against
// DATABASE_URL (the schema owner, e.g. local Supabase) and are skipped without
// it. Keys are minted straight in the database here, as `pgfsm-api key
// bootstrap` would. Assumes the process cwd is the repo root.
const ROOT = Deno.cwd();
const CLI = `${ROOT}/packages/fsm-ctl-ts/src/cli/pgfsmctl.ts`;
const CONFIG = `${ROOT}/packages/fsm-ctl-ts/deno.json`;
const API_CLI = `${ROOT}/packages/fsm-api-ts/src/cli/index.ts`;
const API_CONFIG = `${ROOT}/packages/fsm-api-ts/deno.json`;
const DATABASE_URL = Deno.env.get("DATABASE_URL");

const WORK_DIR = await Deno.makeTempDir({ prefix: "pgfsmctl-api-" });
globalThis.addEventListener("unload", () => {
  Deno.removeSync(WORK_DIR, { recursive: true });
});

type Run = { code: number; out: string; stdout: string; stderr: string };

async function pgfsmctl(
  args: string[],
  env: Record<string, string> = {},
): Promise<Run> {
  const base = Deno.env.toObject();
  for (
    const k of [
      "DATABASE_URL",
      "PGFSM_DB_URL",
      "PGFSM_URL",
      "PGFSM_API_KEY",
      "PGFSM_PROFILE",
    ]
  ) delete base[k];
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--config", CONFIG, CLI, ...args],
    cwd: WORK_DIR,
    env: {
      ...base,
      NO_COLOR: "1",
      PGFSM_CONFIG_DIR: `${WORK_DIR}/config`,
      ...env,
    },
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  const [o, e] = [dec.decode(stdout), dec.decode(stderr)];
  return { code, out: o + e, stdout: o, stderr: e };
}

const CLOSED = "http://127.0.0.1:1/api/v1";

Deno.test("key: argument errors exit 2 before any network", async () => {
  for (
    const args of [
      ["key", "create", "--role", "admin"], // no --name
      ["key", "create", "--name", "x", "--role", "root"],
      ["key", "revoke"],
      ["scheduler", "register", "--schedule", ""],
    ]
  ) {
    const { code, out } = await pgfsmctl(args, {
      PGFSM_URL: CLOSED,
      PGFSM_API_KEY: "k",
    });
    assertEquals(code, 2, `${args.join(" ")}: ${out}`);
  }
  const noTarget = await pgfsmctl(["key", "list"]);
  assertEquals(noTarget.code, 2);
  assertStringIncludes(noTarget.out, "no API configured");

  const noKey = await pgfsmctl(["key", "list"], { PGFSM_URL: CLOSED });
  assertEquals(noKey.code, 2);
  assertStringIncludes(noKey.out, "no API key");
});

Deno.test("an unreachable API exits 1 and names the URL; a DATABASE_URL is never used", async () => {
  const list = await pgfsmctl([
    "key",
    "list",
    "--url",
    CLOSED,
    "--api-key",
    "k",
  ]);
  assertEquals(list.code, 1);
  assertStringIncludes(
    list.out,
    "Can't reach the pgfsm API at http://127.0.0.1:1/api/v1",
  );

  const dir = `${WORK_DIR}/defs`;
  await Deno.mkdir(`${dir}/m/v01`, { recursive: true });
  await Deno.writeTextFile(`${dir}/m/v01/fsm.json`, '{"id":"m"}');
  const load = await pgfsmctl(["fsm", "load", dir], {
    PGFSM_URL: CLOSED,
    PGFSM_API_KEY: "k",
    DATABASE_URL: "postgresql://u@127.0.0.1:1/db",
  });
  assertEquals(load.code, 1);
  assertStringIncludes(load.out, "via the API");
  assertStringIncludes(load.out, "Can't reach the pgfsm API");
});

// --- Against a real API + database ---

function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = l.addr as Deno.NetAddr;
  l.close();
  return port;
}

/** Starts the API with the admin routes on; returns its base URL. */
async function startApi(): Promise<{ url: string; stop: () => Promise<void> }> {
  const port = freePort();
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-all",
      "--config",
      API_CONFIG,
      API_CLI,
      "--db-url",
      DATABASE_URL!,
      "--port",
      String(port),
      "--enable-admin-api",
    ],
    cwd: WORK_DIR,
    env: { DB_TYPE: "postgres", NO_COLOR: "1" },
    stdout: "null",
    stderr: "null",
  }).spawn();
  const url = `http://127.0.0.1:${port}/api/v1`;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${url}/instances`);
      await res.body?.cancel();
      if (res.status === 401) {
        return {
          url,
          stop: async () => {
            // Graceful first (the API drains and exits on SIGTERM); never
            // let a regression there hang the suite.
            child.kill("SIGTERM");
            const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
            await child.status;
            clearTimeout(timer);
          },
        };
      }
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill("SIGKILL");
  await child.status;
  throw new Error("API didn't start");
}

const db = {
  ignore: !DATABASE_URL,
  sanitizeResources: false,
  sanitizeOps: false,
};

/** An API key named `<prefix><role>`, minted in the database. */
async function mint(prefix: string, role: "admin" | "operator") {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    return (await createApiKey(
      { db: pool, useSupabase: false },
      `${prefix}${role}`,
      role === "admin" ? "fsm_admin" : "fsm_operator",
    )).key;
  } finally {
    await pool.end();
  }
}

async function cleanup(prefix: string) {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    await pool.query("DELETE FROM fsm_core.api_keys WHERE name LIKE $1", [
      `${prefix}%`,
    ]);
    // Instances the instance tests created (#660), with their queues.
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM fsm_core.fsm_instance WHERE fsm_name LIKE $1",
      [`${prefix}%`],
    );
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
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
    }
    for (const t of ["fsm_transitions", "fsm_states", "fsm_json"]) {
      await pool.query(`DELETE FROM fsm_core.${t} WHERE fsm_name LIKE $1`, [
        `${prefix}%`,
      ]);
    }
  } finally {
    await pool.end();
  }
}

/** A two-state machine named `id`. */
const machine = (id: string) =>
  JSON.stringify({
    id,
    key: id,
    type: "compound",
    order: -1,
    states: Object.fromEntries(
      [["red", "green", 1], ["green", "red", 2]].map(([k, next, order]) => [k, {
        id: `${id}.${k}`,
        key: k,
        type: "atomic",
        order,
        transitions: [{
          source: `#${id}.${k}`,
          target: [`#${id}.${next}`],
          eventType: "NEXT",
          actions: [],
        }],
      }]),
    ),
  });

Deno.test({
  name:
    "key create/list/revoke through the API with an admin key; bad keys exit 3",
  ...db,
  fn: async () => {
    const prefix = `t473_${crypto.randomUUID().slice(0, 8)}_`;
    const api = await startApi();
    try {
      const adminKey = await mint(prefix, "admin");
      const asAdmin = { PGFSM_URL: api.url, PGFSM_API_KEY: adminKey };

      const listed = await pgfsmctl(["key", "list", "-o", "json"], asAdmin);
      assertEquals(listed.code, 0, listed.out);
      const row = JSON.parse(listed.stdout).find((k: { name: string }) =>
        k.name === `${prefix}admin`
      );
      assert(adminKey.startsWith(row.prefix), "key list shows it by prefix");

      const op = await pgfsmctl(
        [
          "key",
          "create",
          "--name",
          `${prefix}op`,
          "--role",
          "operator",
          "-o",
          "json",
        ],
        asAdmin,
      );
      assertEquals(op.code, 0, op.out);
      const opKey = JSON.parse(op.stdout).key;
      assertMatch(opKey, /^pgfsm_op_/);
      assertStringIncludes(op.stderr, "shown only this once");

      const dup = await pgfsmctl(
        ["key", "create", "--name", `${prefix}op`, "--role", "operator"],
        asAdmin,
      );
      assertEquals(dup.code, 1, "duplicate name (409)");

      const asOperator = await pgfsmctl(["key", "list"], {
        PGFSM_URL: api.url,
        PGFSM_API_KEY: opKey,
      });
      assertEquals(asOperator.code, 3, "operator key on an admin route (403)");
      const bogus = await pgfsmctl(["key", "list"], {
        PGFSM_URL: api.url,
        PGFSM_API_KEY: "pgfsm_admin_nope",
      });
      assertEquals(bogus.code, 3, "unknown key (401)");

      const revoked = await pgfsmctl([
        "key",
        "revoke",
        `${prefix}op`,
        "-o",
        "ids",
      ], asAdmin);
      assertEquals(revoked.code, 0, revoked.out);
      assertEquals(revoked.stdout.trim(), `${prefix}op`);
      const again = await pgfsmctl(["key", "revoke", `${prefix}op`], asAdmin);
      assertEquals(again.code, 4, "no live key with that name");
    } finally {
      await api.stop();
      await cleanup(prefix);
    }
  },
});

Deno.test({
  name:
    "fsm load through the API; again is unchanged; a bad key exits 3; a DATABASE_URL changes nothing",
  ...db,
  fn: async () => {
    const prefix = `t473_${crypto.randomUUID().slice(0, 8)}_`;
    const api = await startApi();
    try {
      const key = await mint(prefix, "admin");
      const dir = `${WORK_DIR}/load-${prefix}`;
      await Deno.mkdir(`${dir}/${prefix}a/v01`, { recursive: true });
      await Deno.writeTextFile(
        `${dir}/${prefix}a/v01/fsm.json`,
        machine(`${prefix}a`),
      );
      // A project's DATABASE_URL around (./.env) must not matter.
      const apiEnv = {
        PGFSM_URL: api.url,
        PGFSM_API_KEY: key,
        DATABASE_URL: "postgresql://u@127.0.0.1:1/db",
      };

      const loaded = await pgfsmctl(["fsm", "load", dir, "-o", "ids"], apiEnv);
      assertEquals(loaded.code, 0, loaded.out);
      assertStringIncludes(loaded.stderr, "via the API");
      assertEquals(loaded.stdout.trim(), `${prefix}a/v01`);

      const again = await pgfsmctl(["fsm", "load", dir, "-o", "json"], apiEnv);
      assertEquals(JSON.parse(again.stdout)[0].status, "unchanged");

      const badKey = await pgfsmctl(["fsm", "load", dir], {
        PGFSM_URL: api.url,
        PGFSM_API_KEY: "pgfsm_admin_nope",
      });
      assertEquals(badKey.code, 3);
      assert(!badKey.stdout, "nothing on stdout on failure");
    } finally {
      await api.stop();
      await cleanup(prefix);
    }
  },
});

Deno.test({
  name:
    "scheduler status|register through the API with an admin key; an operator key exits 3",
  ...db,
  fn: async () => {
    const prefix = `t690_${crypto.randomUUID().slice(0, 8)}_`;
    const api = await startApi();
    const asAdmin = { PGFSM_URL: api.url, PGFSM_API_KEY: "" };
    try {
      asAdmin.PGFSM_API_KEY = await mint(prefix, "admin");
      const status = await pgfsmctl(
        ["scheduler", "status", "-o", "json"],
        asAdmin,
      );
      assertEquals(status.code, 0, status.out);
      const job = JSON.parse(status.stdout);
      assertEquals(job.jobname, "fsm_schedule_all_pending");
      assertEquals(job.registered, true);

      const changed = await pgfsmctl(
        ["scheduler", "register", "--schedule", "9 seconds", "-o", "json"],
        asAdmin,
      );
      assertEquals(changed.code, 0, changed.out);
      assertEquals(JSON.parse(changed.stdout).schedule, "9 seconds");

      const bad = await pgfsmctl(
        ["scheduler", "register", "--schedule", "bogus"],
        asAdmin,
      );
      assertEquals(bad.code, 1, bad.out);
      assertStringIncludes(bad.stderr, "invalid schedule");

      const asOperator = await pgfsmctl(["scheduler", "status"], {
        PGFSM_URL: api.url,
        PGFSM_API_KEY: await mint(prefix, "operator"),
      });
      assertEquals(asOperator.code, 3, asOperator.out);
    } finally {
      // Shared database: put the default schedule back.
      if (asAdmin.PGFSM_API_KEY) {
        await pgfsmctl(["scheduler", "register"], asAdmin);
      }
      await api.stop();
      await cleanup(prefix);
    }
  },
});

Deno.test({
  name:
    "instance create/resume/send/stop over the API with an operator key; 4 for an unknown instance (#660)",
  ...db,
  fn: async () => {
    const prefix = `t660_${crypto.randomUUID().slice(0, 8)}_`;
    const api = await startApi();
    try {
      const admin = await mint(prefix, "admin");
      const operator = await mint(prefix, "operator");
      const asOperator = { PGFSM_URL: api.url, PGFSM_API_KEY: operator };

      // A definition to create instances of.
      const fsmName = `${prefix}light`;
      const dir = `${WORK_DIR}/t660-${prefix}`;
      await Deno.mkdir(`${dir}/${fsmName}/v01`, { recursive: true });
      await Deno.writeTextFile(
        `${dir}/${fsmName}/v01/fsm.json`,
        machine(fsmName),
      );
      const load = await pgfsmctl(["fsm", "load", dir], {
        PGFSM_URL: api.url,
        PGFSM_API_KEY: admin,
      });
      assertEquals(load.code, 0, load.out);

      const created = await pgfsmctl([
        "instance",
        "create",
        "-n",
        fsmName,
        "-V",
        "v01",
        "--input",
        '{"who":"op"}',
        "-o",
        "json",
      ], asOperator);
      assertEquals(created.code, 0, created.out);
      assertStringIncludes(created.stderr, "instance create: via the API");
      const instance = JSON.parse(created.stdout);
      assertMatch(instance.fsm_instance_id, /^[0-9a-f-]{36}$/);
      assertEquals(instance.fsm_instance_context, { who: "op" });
      const id = instance.fsm_instance_id as string;

      const sent = await pgfsmctl(
        ["instance", "send", "-q", id, "-e", "NEXT", "-o", "json"],
        asOperator,
      );
      assertEquals(sent.code, 0, sent.out);
      assertStringIncludes(sent.stderr, "via the API");
      assertEquals(JSON.parse(sent.stdout), {
        fsm_instance_id: id,
        event_type: "NEXT",
        sent: true,
      });

      const resumed = await pgfsmctl(
        ["instance", "resume", "-q", id, "-o", "ids"],
        asOperator,
      );
      assertEquals(resumed.code, 0, resumed.out);
      assertEquals(resumed.stdout.trim(), id);

      const stopped = await pgfsmctl(
        ["instance", "stop", "-q", id, "-o", "json"],
        asOperator,
      );
      assertEquals(stopped.code, 0, stopped.out);
      assertEquals(JSON.parse(stopped.stdout), {
        fsm_instance_id: id,
        stop_signal_sent: true,
      });

      // An unknown instance is exit 4 over the API, for each verb.
      const unknown = crypto.randomUUID();
      for (
        const args of [
          ["instance", "send", "-q", unknown, "-e", "NEXT"],
          ["instance", "resume", "-q", unknown],
          ["instance", "stop", "-q", unknown],
        ]
      ) {
        const run = await pgfsmctl(args, asOperator);
        assertEquals(run.code, 4, `${args.join(" ")}: ${run.out}`);
        assertStringIncludes(run.stderr, "via the API");
      }

      // An admin key works too (fsm_admin is a member of fsm_operator).
      const asAdmin = await pgfsmctl(
        ["instance", "send", "-q", id, "-e", "NEXT"],
        { PGFSM_URL: api.url, PGFSM_API_KEY: admin },
      );
      assertEquals(asAdmin.code, 0, asAdmin.out);

      // With only a DATABASE_URL there's no API: exit 2.
      const noApi = await pgfsmctl(
        ["instance", "send", "-q", id, "-e", "NEXT"],
        { DATABASE_URL: DATABASE_URL! },
      );
      assertEquals(noApi.code, 2, noApi.out);

      const badKey = await pgfsmctl(
        ["instance", "send", "-q", id, "-e", "NEXT"],
        { PGFSM_URL: api.url, PGFSM_API_KEY: "pgfsm_op_nope" },
      );
      assertEquals(badKey.code, 3, badKey.out);
    } finally {
      await api.stop();
      await cleanup(prefix);
    }
  },
});

Deno.test({
  name:
    "fsm list/get and instance list/get, over the API with an operator key (#661)",
  ...db,
  fn: async () => {
    const prefix = `t661_${crypto.randomUUID().slice(0, 8)}_`;
    const api = await startApi();
    try {
      const admin = await mint(prefix, "admin");
      const asOperator = {
        PGFSM_URL: api.url,
        PGFSM_API_KEY: await mint(prefix, "operator"),
      };

      const fsmName = `${prefix}light`;
      const dir = `${WORK_DIR}/t661-${prefix}`;
      for (const v of ["v01", "v02"]) {
        await Deno.mkdir(`${dir}/${fsmName}/${v}`, { recursive: true });
        await Deno.writeTextFile(
          `${dir}/${fsmName}/${v}/fsm.json`,
          machine(fsmName),
        );
      }
      const load = await pgfsmctl(["fsm", "load", dir], {
        PGFSM_URL: api.url,
        PGFSM_API_KEY: admin,
      });
      assertEquals(load.code, 0, load.out);

      for (const [tier, env] of [["API", asOperator]] as const) {
        // fsm list / get
        const listed = await pgfsmctl(
          ["fsm", "list", "-n", fsmName, "-o", "ids"],
          env,
        );
        assertEquals(listed.code, 0, `${tier}: ${listed.out}`);
        assertEquals(
          listed.stdout.trim().split("\n"),
          [`${fsmName}/v01`, `${fsmName}/v02`],
        );
        const table = await pgfsmctl(["fsm", "list", "-n", fsmName], env);
        assertStringIncludes(table.stdout, "FSM_JSON_SHA256");
        const got = await pgfsmctl(
          ["fsm", "get", `${fsmName}/v02`, "-o", "json"],
          env,
        );
        assertEquals(got.code, 0, `${tier}: ${got.out}`);
        assertEquals(
          JSON.parse(got.stdout).fsm_json,
          JSON.parse(machine(fsmName)),
        );
        const missing = await pgfsmctl(["fsm", "get", `${fsmName}/v09`], env);
        assertEquals(missing.code, 4, `${tier}: ${missing.out}`);
        assertStringIncludes(missing.stderr, "via the API");
      }

      // Instances: two of v01, one of v02.
      const ids: string[] = [];
      for (const v of ["v01", "v01", "v02"]) {
        const created = await pgfsmctl(
          ["instance", "create", "-n", fsmName, "-V", v, "-o", "ids"],
          asOperator,
        );
        assertEquals(created.code, 0, created.out);
        ids.push(created.stdout.trim());
      }

      for (const [tier, env] of [["API", asOperator]] as const) {
        const all = await pgfsmctl(
          ["instance", "list", "-n", fsmName, "-o", "ids"],
          env,
        );
        assertEquals(all.code, 0, `${tier}: ${all.out}`);
        assertEquals(new Set(all.stdout.trim().split("\n")), new Set(ids));
        const v01 = await pgfsmctl(
          ["instance", "list", "-n", fsmName, "-V", "v01", "-o", "json"],
          env,
        );
        assertEquals(JSON.parse(v01.stdout).length, 2, tier);
        assertEquals(
          Object.keys(JSON.parse(v01.stdout)[0]),
          ["id", "fsm_name", "fsm_version", "status", "state", "started_at"],
        );
        const one = await pgfsmctl(
          ["instance", "list", "-n", fsmName, "--limit", "1", "-o", "ids"],
          env,
        );
        assertEquals(one.stdout.trim().split("\n").length, 1, tier);
        const errored = await pgfsmctl(
          ["instance", "list", "-n", fsmName, "--status", "error", "-o", "ids"],
          env,
        );
        assertEquals(errored.code, 0);
        assertEquals(errored.stdout.trim(), "", tier);

        const got = await pgfsmctl(
          ["instance", "get", "-q", ids[2], "-o", "json"],
          env,
        );
        assertEquals(got.code, 0, `${tier}: ${got.out}`);
        const record = JSON.parse(got.stdout);
        assertEquals(record.fsm_instance_id, ids[2]);
        assertEquals(record.fsm_instance_row.fsm_version, "v02");
        const table = await pgfsmctl(["instance", "get", "-q", ids[2]], env);
        assertStringIncludes(table.stdout, "status:");
        const unknown = await pgfsmctl(
          ["instance", "get", "-q", crypto.randomUUID()],
          env,
        );
        assertEquals(unknown.code, 4, `${tier}: ${unknown.out}`);
      }

      // Bad filters are usage errors, before any request.
      for (
        const args of [
          ["instance", "list", "--status", "sleeping"],
          ["instance", "list", "--limit", "0"],
          ["fsm", "get", "no-version"],
        ]
      ) {
        assertEquals(
          (await pgfsmctl(args, asOperator)).code,
          2,
          args.join(" "),
        );
      }
    } finally {
      await api.stop();
      await cleanup(prefix);
    }
  },
});
