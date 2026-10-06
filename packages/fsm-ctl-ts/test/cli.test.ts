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

// Each run gets its own profile directory, so tests never touch the real
// ~/.config/pgfsm and don't see each other's profiles.
const CONFIG_DIR = await Deno.makeTempDir({ prefix: "pgfsmctl-cfg-" });
globalThis.addEventListener("unload", () => {
  Deno.removeSync(CONFIG_DIR, { recursive: true });
});

async function pgfsmctl(
  args: string[],
  opts: { env?: Record<string, string>; stdin?: string } = {},
): Promise<{ code: number; out: string; stdout: string; stderr: string }> {
  const env = Deno.env.toObject();
  delete env.DATABASE_URL;
  delete env.PGFSM_DB_URL;
  delete env.PGFSM_PROFILE;
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--config", CONFIG, CLI, ...args],
    cwd: EMPTY_DIR,
    env: { ...env, NO_COLOR: "1", PGFSM_CONFIG_DIR: CONFIG_DIR, ...opts.env },
    clearEnv: true,
    stdin: opts.stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (opts.stdin !== undefined) {
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(opts.stdin));
    await w.close();
  }
  const { code, stdout, stderr } = await child.output();
  const dec = new TextDecoder();
  const [o, e] = [dec.decode(stdout), dec.decode(stderr)];
  return { code, out: o + e, stdout: o, stderr: e };
}

Deno.test("--version prints the bare package version", async () => {
  const { code, out } = await pgfsmctl(["--version"]);
  const denoJson = JSON.parse(await Deno.readTextFile(CONFIG));
  assertEquals(code, 0);
  assert(out.split("\n").map((l) => l.trim()).includes(denoJson.version));
});

const NOUNS = [
  "db",
  "fsm",
  "instance",
  "scheduler",
  "config",
  "completion",
  "version",
];

Deno.test("--help lists every noun with its tier; no args is a usage error", async () => {
  const help = await pgfsmctl(["--help"]);
  assertEquals(help.code, 0);
  for (const noun of NOUNS) assertStringIncludes(help.out, noun);
  assertStringIncludes(help.out, "[DB-direct]");
  assertStringIncludes(help.out, "[local]");
  assert(!help.out.includes("pgcron"), "pgcron is gone");
  assertEquals((await pgfsmctl([])).code, 2);
});

Deno.test("unknown nouns, verbs and options exit 2 (usage)", async () => {
  const noun = await pgfsmctl(["fsmctl"]);
  assertEquals(noun.code, 2);
  assertStringIncludes(noun.out, "Unknown command");
  for (
    const args of [
      ["pgcron", "register"],
      ["db"],
      ["db", "cron"],
      ["db", "cron", "drop"],
      ["db", "migrate"],
      ["instance", "kill"],
      ["fsm"],
      ["fsm", "unload"],
      ["config", "delete"],
      ["completion", "powershell"],
      ["db", "cron", "status", "--bogus"],
      ["instance", "create", "--context", "{}"],
      ["fsm", "load", "x", "-o", "yaml"],
    ]
  ) {
    const { code } = await pgfsmctl(args);
    assertEquals(code, 2, args.join(" "));
  }
  const scheduler = await pgfsmctl(["scheduler", "start"]);
  assertEquals(scheduler.code, 2);
  assertStringIncludes(scheduler.out, "Unknown scheduler verb");
  const option = await pgfsmctl(["db", "cron", "status", "--bogus"]);
  assertStringIncludes(option.stderr, "Unknown option: --bogus");
  assertEquals(option.stdout, "", "usage help goes to stderr");
});

Deno.test("each noun has its own --help", async () => {
  for (const noun of NOUNS) {
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
    assertEquals(code, 2, args.join(" "));
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
    "--input",
    "{nope",
  ]);
  assertEquals(context.code, 2);
  assertStringIncludes(context.out, "--input is not valid JSON");

  const notUuid = await pgfsmctl(["instance", "stop", "-q", "x"]);
  assertEquals(notUuid.code, 2);
  assertStringIncludes(notUuid.out, "--queue-name must be an instance UUID");

  const poll = await pgfsmctl(["scheduler", "run", "-p", "0"]);
  assertEquals(poll.code, 2);
  assertStringIncludes(poll.out, "--poll-interval must be a positive integer");
});

Deno.test("without any database target, commands fail clearly (usage)", async () => {
  for (
    const args of [
      ["db", "cron", "status"],
      ["instance", "stop", "-q", crypto.randomUUID()],
      ["scheduler", "run"],
    ]
  ) {
    const { code, out } = await pgfsmctl(args);
    assertEquals(code, 2, args.join(" "));
    assertStringIncludes(out, "No database");
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
  assertEquals(noFolder.code, 2);
  assertStringIncludes(noFolder.out, "fsm load needs a folder");

  const empty = await pgfsmctl(["fsm", "load", EMPTY_DIR]);
  assertEquals(empty.code, 2);
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
    assertEquals(code, 2);
    assertStringIncludes(out, "No database");
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
      const first = await pgfsmctl([
        "fsm",
        "load",
        good,
        "-d",
        DATABASE_URL!,
        "-o",
        "ids",
      ]);
      assertEquals(first.code, 0, first.out);
      assertEquals(
        first.stdout.trim().split("\n"),
        [`${child}/v01`, `${parent}/v01`],
        "children load before parents",
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
      // @ts-types="@types/pg"
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

// --- SPEC-009 conventions (#471) ---

Deno.test("-o json/ids put only data on stdout; logs stay on stderr", async () => {
  const json = await pgfsmctl(["version", "-o", "json"]);
  assertEquals(json.code, 0);
  assertEquals(JSON.parse(json.stdout), {
    version: JSON.parse(await Deno.readTextFile(CONFIG)).version,
  });
  const list = await pgfsmctl(["config", "list", "-o", "json"]);
  assertEquals(list.code, 0);
  assert(Array.isArray(JSON.parse(list.stdout)));
});

Deno.test("completion prints a script per shell", async () => {
  for (const shell of ["bash", "zsh", "fish"]) {
    const { code, stdout } = await pgfsmctl(["completion", shell]);
    assertEquals(code, 0, shell);
    // fish spells flags as `-l input`, the others as `--input`.
    for (const word of ["db", "instance", "config", "input"]) {
      assertStringIncludes(stdout, word, `${shell}: ${word}`);
    }
  }
  const bash = (await pgfsmctl(["completion", "bash"])).stdout;
  assertStringIncludes(bash, '"db cron") words="register unregister status');
});

/** A fresh profile dir for one test, removed afterwards. */
async function withConfigDir(
  fn: (env: Record<string, string>, dir: string) => Promise<void>,
) {
  const dir = await Deno.makeTempDir({ prefix: "pgfsmctl-profiles-" });
  try {
    await fn({ PGFSM_CONFIG_DIR: dir }, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("config: set/use/list/show; secrets only in a 0600 credentials.json", () =>
  withConfigDir(async (env, dir) => {
    const withPw = await pgfsmctl(
      ["config", "set", "a", "--db-url", "postgresql://u:secret@h/db"],
      { env },
    );
    assertEquals(withPw.code, 2, "a password in --db-url is refused");

    const set = await pgfsmctl(
      ["config", "set", "a", "--db-url", "postgresql://u@h:5432/db"],
      { env },
    );
    assertEquals(set.code, 0, set.out);
    const pw = await pgfsmctl(
      ["config", "set", "a", "--db-password-stdin"],
      { env, stdin: "s3cret\n" },
    );
    assertEquals(pw.code, 0, pw.out);
    await pgfsmctl(["config", "set", "b", "--url", "https://api.example"], {
      env,
    });

    const yaml = await Deno.readTextFile(`${dir}/config.yaml`);
    assert(!yaml.includes("s3cret"), "no secret in config.yaml");
    assertStringIncludes(yaml, "current: a", "first profile becomes current");
    const creds = JSON.parse(
      await Deno.readTextFile(`${dir}/credentials.json`),
    );
    assertEquals(creds.profiles.a.db_password, "s3cret");
    if (Deno.build.os !== "windows") {
      assertEquals(
        (await Deno.stat(`${dir}/credentials.json`)).mode! & 0o777,
        0o600,
      );
    }

    const ids = await pgfsmctl(["config", "list", "-o", "ids"], { env });
    assertEquals(ids.stdout.trim().split("\n"), ["a", "b"]);
    const shown = JSON.parse(
      (await pgfsmctl(["config", "show", "a", "-o", "json"], { env })).stdout,
    );
    assertEquals(shown.db_password, "set");
    assert(
      !JSON.stringify(shown).includes("s3cret"),
      "show never prints secrets",
    );

    assertEquals((await pgfsmctl(["config", "use", "b"], { env })).code, 0);
    assertStringIncludes(
      await Deno.readTextFile(`${dir}/config.yaml`),
      "current: b",
    );
    assertEquals((await pgfsmctl(["config", "use", "nope"], { env })).code, 4);
    assertEquals((await pgfsmctl(["config", "show", "nope"], { env })).code, 4);
  }));

// Which target a command picked, from its debug log. The ports are closed,
// so the command then fails to connect: only the choice is under test.
async function pickedTarget(
  args: string[],
  env: Record<string, string>,
): Promise<string> {
  const { stderr } = await pgfsmctl(args, {
    env: { ...env, PGFSMCTL_LOG_LEVEL: "debug" },
  });
  return /Database from "?([^"\n]+)"?/.exec(stderr)?.[1] ?? `none: ${stderr}`;
}

Deno.test("target precedence: --db-url > --profile/PGFSM_PROFILE > env > current profile", () =>
  withConfigDir(async (env) => {
    for (const name of ["cur", "other"]) {
      await pgfsmctl(
        [
          "config",
          "set",
          name,
          "--db-url",
          `postgresql://u@127.0.0.1:1/${name}`,
        ],
        { env },
      );
    }
    await pgfsmctl(["config", "use", "cur"], { env });
    const status = ["db", "cron", "status"];
    const dbEnv = { ...env, DATABASE_URL: "postgresql://u@127.0.0.1:1/env" };

    assertEquals(await pickedTarget(status, env), "profile cur");
    assertEquals(await pickedTarget(status, dbEnv), "$DATABASE_URL");
    assertEquals(
      await pickedTarget(status, {
        ...dbEnv,
        PGFSM_DB_URL: "postgresql://u@127.0.0.1:1/x",
      }),
      "$PGFSM_DB_URL",
    );
    assertEquals(
      await pickedTarget([...status, "--profile", "other"], dbEnv),
      "profile other",
      "an explicit --profile beats DATABASE_URL",
    );
    assertEquals(
      await pickedTarget(status, { ...dbEnv, PGFSM_PROFILE: "other" }),
      "profile other",
    );
    assertEquals(
      await pickedTarget(
        [
          ...status,
          "--profile",
          "other",
          "-d",
          "postgresql://u@127.0.0.1:1/flag",
        ],
        dbEnv,
      ),
      "--db-url",
    );
    const ghost = await pgfsmctl([...status, "--profile", "ghost"], { env });
    assertEquals(ghost.code, 4);
  }));

Deno.test({
  name: "instance commands exit 4 for an unknown instance",
  ignore: !DATABASE_URL,
  fn: async () => {
    const id = crypto.randomUUID();
    for (const verb of ["stop", "resume"]) {
      const { code, out } = await pgfsmctl([
        "instance",
        verb,
        "-q",
        id,
        "-d",
        DATABASE_URL!,
      ]);
      assertEquals(code, 4, `${verb}: ${out}`);
    }
    const send = await pgfsmctl([
      "instance",
      "send",
      "-q",
      id,
      "-e",
      "GO",
      "-d",
      DATABASE_URL!,
    ]);
    assertEquals(send.code, 4, send.out);
  },
});

Deno.test({
  name:
    "db cron status -o json reports the job, and exits 5 when it isn't registered",
  ignore: !DATABASE_URL,
  fn: async () => {
    // Shared local database: read the current state, never change it.
    const { code, stdout, out } = await pgfsmctl([
      "db",
      "cron",
      "status",
      "-d",
      DATABASE_URL!,
      "-o",
      "json",
    ]);
    const job = JSON.parse(stdout);
    if (job.registered) {
      assertEquals(code, 0, out);
      assertEquals(job.jobname, "fsm_schedule_all_pending");
    } else {
      assertEquals(code, 5, out);
    }
  },
});
