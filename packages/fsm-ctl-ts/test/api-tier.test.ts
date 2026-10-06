import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";

// The API tier (SPEC-009 §4–5, #473): `db key create`, `key …`, and
// `fsm load`'s choice between the REST API and DB-direct. Argument tests need
// nothing; the rest start the real API (apps/fsm-core-ts-hono-deno) as a
// subprocess against DATABASE_URL (the schema owner, e.g. local Supabase) and
// are skipped without it. Assumes the process cwd is the repo root.
const ROOT = Deno.cwd();
const CLI = `${ROOT}/packages/fsm-ctl-ts/src/cli/pgfsmctl.ts`;
const CONFIG = `${ROOT}/packages/fsm-ctl-ts/deno.json`;
const API_CLI = `${ROOT}/apps/fsm-core-ts-hono-deno/src/cli/index.ts`;
const API_CONFIG = `${ROOT}/apps/fsm-core-ts-hono-deno/deno.json`;
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

const CLOSED = "http://127.0.0.1:1/fsm";

Deno.test("key and db key: argument errors exit 2 before any network", async () => {
  for (
    const args of [
      ["key", "create", "--role", "admin"], // no --name
      ["key", "create", "--name", "x", "--role", "root"],
      ["key", "revoke"],
      ["db", "key", "create", "--role", "admin"],
      ["db", "key", "create", "--name", "x"],
      ["db", "key", "delete"],
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
  assertStringIncludes(noTarget.out, "No API");

  const noKey = await pgfsmctl(["key", "list"], { PGFSM_URL: CLOSED });
  assertEquals(noKey.code, 2);
  assertStringIncludes(noKey.out, "no API key");
});

Deno.test("an unreachable API exits 1 and names the URL; fsm load picks the API tier", async () => {
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
    "Can't reach the pgfsm API at http://127.0.0.1:1/fsm",
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
  assertStringIncludes(
    load.out,
    "via the API",
    "the API wins when both resolve",
  );
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
    env: {
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SERVICE_ROLE_KEY: "test",
      SUPABASE_ANON_KEY: "test",
      DB_TYPE: "postgres",
      NO_COLOR: "1",
    },
    stdout: "null",
    stderr: "null",
  }).spawn();
  const url = `http://127.0.0.1:${port}/fsm`;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${url}/fsm`);
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

async function cleanup(prefix: string) {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    await pool.query("DELETE FROM fsm_core.api_keys WHERE name LIKE $1", [
      `${prefix}%`,
    ]);
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
    "db key create mints an admin key; key create/list/revoke use it through the API; bad keys exit 3",
  ...db,
  fn: async () => {
    const prefix = `t473_${crypto.randomUUID().slice(0, 8)}_`;
    const api = await startApi();
    try {
      const minted = await pgfsmctl([
        "db",
        "key",
        "create",
        "--name",
        `${prefix}admin`,
        "--role",
        "admin",
        "-d",
        DATABASE_URL!,
        "-o",
        "json",
      ]);
      assertEquals(minted.code, 0, minted.out);
      const admin = JSON.parse(minted.stdout);
      assertMatch(admin.key, /^pgfsm_admin_[0-9a-f]{64}$/);
      assertStringIncludes(minted.stderr, "shown only this once");
      const asAdmin = { PGFSM_URL: api.url, PGFSM_API_KEY: admin.key };

      const listed = await pgfsmctl(["key", "list", "-o", "json"], asAdmin);
      assertEquals(listed.code, 0, listed.out);
      const row = JSON.parse(listed.stdout).find((k: { name: string }) =>
        k.name === `${prefix}admin`
      );
      assertEquals(row.prefix, admin.prefix, "key list shows it by prefix");

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
    "fsm load: API with PGFSM_URL + key, DB-direct with only DATABASE_URL, API when both, DB-direct with --db-url",
  ...db,
  fn: async () => {
    const prefix = `t473_${crypto.randomUUID().slice(0, 8)}_`;
    const api = await startApi();
    try {
      const { stdout } = await pgfsmctl([
        "db",
        "key",
        "create",
        "--name",
        `${prefix}admin`,
        "--role",
        "admin",
        "-d",
        DATABASE_URL!,
        "-o",
        "json",
      ]);
      const key = JSON.parse(stdout).key;
      const folder = async (name: string) => {
        const dir = `${WORK_DIR}/${name}`;
        await Deno.mkdir(`${dir}/${prefix}${name}/v01`, { recursive: true });
        await Deno.writeTextFile(
          `${dir}/${prefix}${name}/v01/fsm.json`,
          machine(`${prefix}${name}`),
        );
        return dir;
      };
      const apiEnv = { PGFSM_URL: api.url, PGFSM_API_KEY: key };
      const dbEnv = { DATABASE_URL: DATABASE_URL! };

      const viaApi = await pgfsmctl([
        "fsm",
        "load",
        await folder("a"),
        "-o",
        "ids",
      ], apiEnv);
      assertEquals(viaApi.code, 0, viaApi.out);
      assertStringIncludes(viaApi.stderr, "via the API");
      assertEquals(viaApi.stdout.trim(), `${prefix}a/v01`);

      const direct = await pgfsmctl(["fsm", "load", await folder("b")], dbEnv);
      assertEquals(direct.code, 0, direct.out);
      assertStringIncludes(direct.stderr, "DB-direct");

      const both = await pgfsmctl(
        ["fsm", "load", await folder("c")],
        { ...apiEnv, ...dbEnv },
      );
      assertEquals(both.code, 0, both.out);
      assertStringIncludes(both.stderr, "via the API");

      const forced = await pgfsmctl(
        ["fsm", "load", await folder("d"), "-d", DATABASE_URL!],
        apiEnv,
      );
      assertEquals(forced.code, 0, forced.out);
      assertStringIncludes(forced.stderr, "DB-direct");

      const again = await pgfsmctl([
        "fsm",
        "load",
        `${WORK_DIR}/a`,
        "-o",
        "json",
      ], apiEnv);
      assertEquals(JSON.parse(again.stdout)[0].status, "unchanged");

      const badKey = await pgfsmctl(["fsm", "load", `${WORK_DIR}/a`], {
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
