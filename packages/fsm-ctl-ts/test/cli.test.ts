import { assert, assertEquals, assertStringIncludes } from "@std/assert";

// Drives the real CLI as a subprocess, from a throwaway directory with no
// pgfsm.config.json and no .env: pgfsmctl must never need a project
// (SPEC-005). These cover argument handling only -- CI's deno test job has
// no database; the DB paths are the same @pgfsm/db calls the old
// fsmctl/pgcron/fsmscheduler bins made. Assumes the process cwd is the repo
// root, like @pgfsm/cli's tests.
const CLI = `${Deno.cwd()}/packages/fsm-ctl-ts/src/cli/pgfsmctl.ts`;
const CONFIG = `${Deno.cwd()}/packages/fsm-ctl-ts/deno.json`;
const EMPTY_DIR = await Deno.makeTempDir({ prefix: "pgfsmctl-test-" });
globalThis.addEventListener("unload", () => {
  Deno.removeSync(EMPTY_DIR, { recursive: true });
});

async function pgfsmctl(
  args: string[],
): Promise<{ code: number; out: string }> {
  const env = Deno.env.toObject();
  delete env.DATABASE_URL;
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--config", CONFIG, CLI, ...args],
    cwd: EMPTY_DIR,
    env: { ...env, NO_COLOR: "1" },
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return { code, out: dec.decode(stdout) + dec.decode(stderr) };
}

Deno.test("--version prints the bare package version", async () => {
  const { code, out } = await pgfsmctl(["--version"]);
  const denoJson = JSON.parse(await Deno.readTextFile(CONFIG));
  assertEquals(code, 0);
  assert(out.split("\n").map((l) => l.trim()).includes(denoJson.version));
});

Deno.test("--help lists every noun; no args is an error", async () => {
  const help = await pgfsmctl(["--help"]);
  assertEquals(help.code, 0);
  for (const noun of ["pgcron", "fsm", "instance", "scheduler"]) {
    assertStringIncludes(help.out, noun);
  }
  assertEquals((await pgfsmctl([])).code, 1);
});

Deno.test("unknown noun and unknown verbs exit 1", async () => {
  const noun = await pgfsmctl(["fsmctl"]);
  assertEquals(noun.code, 1);
  assertStringIncludes(noun.out, "Unknown command");
  for (
    const args of [
      ["pgcron"],
      ["pgcron", "drop"],
      ["instance", "kill"],
      ["fsm"],
      ["fsm", "unload"],
    ]
  ) {
    const { code } = await pgfsmctl(args);
    assertEquals(code, 1, args.join(" "));
  }
  const scheduler = await pgfsmctl(["scheduler", "start"]);
  assertEquals(scheduler.code, 1);
  assertStringIncludes(scheduler.out, "Unknown scheduler verb");
});

Deno.test("each noun has its own --help", async () => {
  for (const noun of ["pgcron", "fsm", "instance", "scheduler"]) {
    const { code, out } = await pgfsmctl([noun, "--help"]);
    assertEquals(code, 0, noun);
    assertStringIncludes(out, `pgfsmctl ${noun}`);
  }
  const { out } = await pgfsmctl(["scheduler", "--help"]);
  assertStringIncludes(out, "FALLBACK");
});

Deno.test("instance verbs name their missing required flags", async () => {
  const cases: [string[], string[]][] = [
    [["instance", "create"], ["--fsm-name", "--fsm-version"]],
    [["instance", "resume"], ["--queue-name"]],
    [["instance", "send", "-q", "x"], ["--event-type"]],
    [["instance", "stop"], ["--queue-name"]],
  ];
  for (const [args, flags] of cases) {
    const { code, out } = await pgfsmctl(args);
    assertEquals(code, 1, args.join(" "));
    for (const flag of flags) assertStringIncludes(out, flag);
  }
});

Deno.test("invalid JSON and integer flags are rejected before connecting", async () => {
  const context = await pgfsmctl([
    "instance",
    "create",
    "-n",
    "creditCheck",
    "-V",
    "v01",
    "--context",
    "{nope",
  ]);
  assertEquals(context.code, 1);
  assertStringIncludes(context.out, "--context is not valid JSON");

  const poll = await pgfsmctl(["scheduler", "run", "-p", "0"]);
  assertEquals(poll.code, 1);
  assertStringIncludes(poll.out, "--poll-interval must be a positive integer");
});

Deno.test("without --db-url or DATABASE_URL, commands fail clearly", async () => {
  for (
    const args of [
      ["pgcron", "status"],
      ["instance", "stop", "-q", "x"],
      ["scheduler", "run"],
    ]
  ) {
    const { code, out } = await pgfsmctl(args);
    assertEquals(code, 1, args.join(" "));
    assertStringIncludes(out, "DATABASE_URL is required");
  }
});

/** Writes `<dir>/<name>/<version>/fsm.json` for each entry; returns dir. */
async function fsmFolder(
  defs: Record<string, string>,
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "pgfsmctl-fsm-" });
  for (const [path, content] of Object.entries(defs)) {
    await Deno.mkdir(`${dir}/${path}`, { recursive: true });
    await Deno.writeTextFile(`${dir}/${path}/fsm.json`, content);
  }
  return dir;
}

Deno.test("fsm load checks its folder before connecting", async () => {
  const noFolder = await pgfsmctl(["fsm", "load"]);
  assertEquals(noFolder.code, 1);
  assertStringIncludes(noFolder.out, "fsm load needs a folder");

  const empty = await pgfsmctl(["fsm", "load", EMPTY_DIR]);
  assertEquals(empty.code, 1);
  assertStringIncludes(empty.out, "no <fsmName>/<version>/fsm.json found");

  const bad = await fsmFolder({ "broken/v01": "{nope" });
  try {
    const { code, out } = await pgfsmctl(["fsm", "load", bad]);
    assertEquals(code, 1);
    assertStringIncludes(out, "broken/v01/fsm.json: invalid JSON");
  } finally {
    await Deno.remove(bad, { recursive: true });
  }

  const ok = await fsmFolder({ "m/v01": '{"id": "m"}' });
  try {
    const { code, out } = await pgfsmctl(["fsm", "load", ok]);
    assertEquals(code, 1);
    assertStringIncludes(out, "DATABASE_URL is required");
  } finally {
    await Deno.remove(ok, { recursive: true });
  }
});

// --- Needs a pgfsm database (DATABASE_URL), e.g. local Supabase.
const DATABASE_URL = Deno.env.get("DATABASE_URL");

Deno.test({
  name:
    "fsm load loads a folder once, then reports it unchanged; a bad batch loads nothing",
  ignore: !DATABASE_URL,
  fn: async () => {
    const tag = `spec006ctl${crypto.randomUUID().slice(0, 8)}`;
    const machine = (id: string, invoke = "") =>
      `{"id":"${id}","key":"${id}","type":"atomic","order":-1${invoke}}`;
    const child = `${tag}Child`;
    // The parent sorts first and invokes the child: it must load second.
    const parent = `${tag}AParent`;
    const invoke =
      `,"invoke":[{"id":"c","src":"${child}","type":"xstate.invoke","asyncOperationType":"fsm","asyncOperationVersion":"v01"}]`;
    const good = await fsmFolder({
      [`${parent}/v01`]: machine(parent, invoke),
      [`${child}/v01`]: machine(child),
    });
    const bad = await fsmFolder({
      [`${tag}Fresh/v01`]: machine(`${tag}Fresh`),
      [`${tag}Orphan/v01`]: machine(
        `${tag}Orphan`,
        invoke.replace(child, `${tag}Nowhere`),
      ),
    });
    try {
      const first = await pgfsmctl(["fsm", "load", good, "-d", DATABASE_URL!]);
      assertEquals(first.code, 0, first.out);
      assert(
        first.out.indexOf(`loaded ${child}/v01`) <
          first.out.indexOf(`loaded ${parent}/v01`),
        first.out,
      );
      const again = await pgfsmctl(["fsm", "load", good, "-d", DATABASE_URL!]);
      assertEquals(again.code, 0, again.out);
      assertStringIncludes(again.out, "0 loaded, 2 unchanged");

      const failed = await pgfsmctl(["fsm", "load", bad, "-d", DATABASE_URL!]);
      assertEquals(failed.code, 1);
      assertStringIncludes(failed.out, "nothing loaded");
      assertStringIncludes(failed.out, `${tag}Nowhere/v01`);
    } finally {
      await Deno.remove(good, { recursive: true });
      await Deno.remove(bad, { recursive: true });
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: DATABASE_URL });
      for (const table of ["fsm_dependencies", "fsm_states", "fsm_json"]) {
        const col = table === "fsm_dependencies"
          ? "parent_fsm_name"
          : "fsm_name";
        await pool.query(`DELETE FROM fsm_core.${table} WHERE ${col} LIKE $1`, [
          `${tag}%`,
        ]);
      }
      await pool.end();
    }
  },
});
