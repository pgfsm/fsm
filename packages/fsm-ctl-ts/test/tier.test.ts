import { assertEquals, assertStringIncludes } from "@std/assert";

// API-only mode (#663): tier: api on a profile, or PGFSM_TIER=api, refuses
// every database connection, --db-url included. Every case stops with exit 2
// before connecting to anything, or reaches the API on a closed port (exit
// 1), so none needs a database or a running API. Assumes the process cwd is
// the repo root.
const CLI = `${Deno.cwd()}/packages/fsm-ctl-ts/src/cli/pgfsmctl.ts`;
const CONFIG = `${Deno.cwd()}/packages/fsm-ctl-ts/deno.json`;
const WORK_DIR = await Deno.makeTempDir({ prefix: "pgfsmctl-tier-" });
globalThis.addEventListener("unload", () => {
  Deno.removeSync(WORK_DIR, { recursive: true });
});

const CLOSED_DB = "postgresql://nobody@127.0.0.1:1/none";
const CLOSED_API = "http://127.0.0.1:1/api/v1";
const PINNED = "the tier is pinned to api";
const ID = "00000000-0000-4000-8000-000000000000";

/** Runs pgfsmctl with its own profile directory and a clean environment. */
async function pgfsmctl(
  args: string[],
  opts: { env?: Record<string, string>; configDir?: string } = {},
): Promise<{ code: number; out: string }> {
  const env = Deno.env.toObject();
  for (
    const k of [
      "DATABASE_URL",
      "PGFSM_DB_URL",
      "PGFSM_URL",
      "PGFSM_API_KEY",
      "PGFSM_PROFILE",
      "PGFSM_TIER",
    ]
  ) delete env[k];
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--config", CONFIG, CLI, ...args],
    cwd: WORK_DIR,
    env: {
      ...env,
      NO_COLOR: "1",
      PGFSM_CONFIG_DIR: opts.configDir ?? `${WORK_DIR}/no-profiles`,
      ...opts.env,
    },
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return { code, out: dec.decode(stdout) + dec.decode(stderr) };
}

const pinnedByEnv = { PGFSM_TIER: "api" };
const api = { PGFSM_URL: CLOSED_API, PGFSM_API_KEY: "k" };

Deno.test("PGFSM_TIER=api refuses every DB-direct path, --db-url included", async () => {
  for (
    const args of [
      ["db", "cron", "status", "--db-url", CLOSED_DB],
      ["db", "key", "create", "--name", "k", "--role", "admin"],
      ["scheduler", "run", "--db-url", CLOSED_DB],
      // Dual-tier commands with no API target don't fall back.
      ["instance", "send", "-q", ID, "-e", "GO"],
      ["instance", "list"],
      ["fsm", "list"],
    ]
  ) {
    const run = await pgfsmctl(args, {
      env: { ...pinnedByEnv, DATABASE_URL: CLOSED_DB },
    });
    assertEquals(run.code, 2, args.join(" "));
    assertStringIncludes(run.out, PINNED, args.join(" "));
    assertStringIncludes(run.out, "from $PGFSM_TIER", args.join(" "));
  }
});

Deno.test("pinned: dual-tier commands use the API, and --db-url is refused", async () => {
  const dir = `${WORK_DIR}/defs`;
  await Deno.mkdir(`${dir}/m/v01`, { recursive: true });
  await Deno.writeTextFile(`${dir}/m/v01/fsm.json`, '{"id":"m"}');

  // With an API target they go to the API, as unpinned (exit 1: closed port).
  for (
    const args of [
      ["fsm", "load", dir],
      ["fsm", "list"],
      ["instance", "send", "-q", ID, "-e", "GO"],
      ["instance", "get", "-q", ID],
    ]
  ) {
    const run = await pgfsmctl(args, {
      env: { ...pinnedByEnv, ...api, DATABASE_URL: CLOSED_DB },
    });
    assertEquals(run.code, 1, `${args.join(" ")}: ${run.out}`);
    assertStringIncludes(run.out, "via the API", args.join(" "));
  }

  // --db-url, which otherwise forces DB-direct, is refused too.
  for (
    const args of [
      ["fsm", "load", dir, "--db-url", CLOSED_DB],
      ["instance", "send", "-q", ID, "-e", "GO", "--db-url", CLOSED_DB],
    ]
  ) {
    const run = await pgfsmctl(args, { env: { ...pinnedByEnv, ...api } });
    assertEquals(run.code, 2, args.join(" "));
    assertStringIncludes(run.out, PINNED);
  }
});

Deno.test("a profile's tier: api pins it; config show and list report the tier", async () => {
  const configDir = `${WORK_DIR}/profiles-pinned`;
  const set = await pgfsmctl([
    "config",
    "set",
    "ops",
    "--url",
    CLOSED_API,
    "--tier",
    "api",
    "--use",
    "-o",
    "json",
  ], { configDir });
  assertEquals(set.code, 0, set.out);
  assertStringIncludes(set.out, '"tier": "api"');

  // As the current profile, and as an explicitly chosen one.
  const envs: Record<string, string>[] = [
    { DATABASE_URL: CLOSED_DB },
    { PGFSM_PROFILE: "ops", DATABASE_URL: CLOSED_DB },
  ];
  for (const env of envs) {
    const run = await pgfsmctl(
      ["db", "cron", "status", "--db-url", CLOSED_DB],
      { configDir, env },
    );
    assertEquals(run.code, 2);
    assertStringIncludes(run.out, `${PINNED} (from profile ops)`);
  }

  const list = await pgfsmctl(["config", "list", "-o", "json"], { configDir });
  assertEquals(list.code, 0);
  assertStringIncludes(list.out, '"tier": "api"');
});

Deno.test("tier precedence: explicit profile, then PGFSM_TIER, then the current profile", async () => {
  const configDir = `${WORK_DIR}/profiles-precedence`;
  for (
    const args of [
      ["config", "set", "pinned", "--url", CLOSED_API, "--tier", "api"],
      ["config", "set", "open", "--db-url", CLOSED_DB, "--tier", "auto"],
      ["config", "set", "plain", "--db-url", CLOSED_DB],
      ["config", "use", "pinned"],
    ]
  ) {
    assertEquals((await pgfsmctl(args, { configDir })).code, 0, args.join(" "));
  }
  const status = (env: Record<string, string>) =>
    pgfsmctl(["db", "cron", "status", "--db-url", CLOSED_DB], {
      configDir,
      env,
    });

  // PGFSM_TIER=auto overrides the pinned current profile: the command gets
  // past the check and fails to connect instead (exit 1).
  const envOverCurrent = await status({ PGFSM_TIER: "auto" });
  assertEquals(envOverCurrent.code, 1, envOverCurrent.out);

  // An explicit profile's tier: auto overrides PGFSM_TIER=api.
  const explicitAuto = await status({
    PGFSM_TIER: "api",
    PGFSM_PROFILE: "open",
  });
  assertEquals(explicitAuto.code, 1, explicitAuto.out);

  // An explicit profile with no tier doesn't unpin PGFSM_TIER=api.
  const explicitPlain = await status({
    PGFSM_TIER: "api",
    PGFSM_PROFILE: "plain",
  });
  assertEquals(explicitPlain.code, 2);
  assertStringIncludes(explicitPlain.out, `${PINNED} (from $PGFSM_TIER)`);
});

Deno.test("an unknown tier is a usage error, from the env or from config set", async () => {
  const bad = await pgfsmctl(["db", "cron", "status", "--db-url", CLOSED_DB], {
    env: { PGFSM_TIER: "API" },
  });
  assertEquals(bad.code, 2);
  assertStringIncludes(bad.out, "$PGFSM_TIER must be one of api, auto");

  const set = await pgfsmctl(["config", "set", "x", "--tier", "db"], {
    configDir: `${WORK_DIR}/profiles-bad`,
  });
  assertEquals(set.code, 2);
  assertStringIncludes(set.out, "--tier must be one of api, auto");
});

Deno.test("unpinned, nothing changes: --db-url still forces DB-direct", async () => {
  const run = await pgfsmctl(["db", "cron", "status", "--db-url", CLOSED_DB]);
  assertEquals(run.code, 1, run.out);
});
