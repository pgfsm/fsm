import { assert, assertEquals, assertStringIncludes } from "@std/assert";

// Drives the real CLI as a subprocess, from a throwaway directory with no
// pgfsm.config.json and no .env: pgfsmctl must never need a project
// (SPEC-005). These cover argument handling, output, profiles and target
// resolution with no API running; test/api-tier.test.ts runs the commands
// against a real API. Assumes the process cwd is the repo root, like
// @pgfsm/cli's tests.
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
  delete env.PGFSM_URL;
  delete env.PGFSM_API_KEY;
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
  "fsm",
  "key",
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
  assertStringIncludes(help.out, "[API]");
  assertStringIncludes(help.out, "[local]");
  assert(!help.out.includes("pgcron"), "pgcron is gone");
  for (const gone of ["db cron", "db key", "scheduler run", "--db-url"]) {
    assert(!help.out.includes(gone), `${gone} is gone (SPEC-016)`);
  }
  assertEquals((await pgfsmctl([])).code, 2);
});

Deno.test("--help's summary lists every verb of every noun (#684)", async () => {
  const { COMMAND_TREE } = await import("../src/commands/tree.ts");
  const lines = (await pgfsmctl(["--help"])).out.split("\n");
  // The summary line starting with `prefix`, e.g. "  fsm load | list | get".
  const check = (prefix: string, verbs: string[]) => {
    const line = lines.find((l) => l.startsWith(`  ${prefix} `));
    assert(line, `--help has no summary line for ${prefix}`);
    for (const verb of verbs) {
      assertStringIncludes(line, verb, `${prefix} ${verb} is missing`);
    }
  };
  for (const [noun, spec] of Object.entries(COMMAND_TREE)) {
    if (Array.isArray(spec.verbs)) check(noun, spec.verbs);
    else {
      // A noun with sub-nouns: one summary line each.
      for (const [sub, verbs] of Object.entries(spec.verbs)) {
        check(`${noun} ${sub}`, verbs);
      }
    }
  }
});

Deno.test("unknown nouns, verbs and options exit 2 (usage)", async () => {
  const noun = await pgfsmctl(["fsmctl"]);
  assertEquals(noun.code, 2);
  assertStringIncludes(noun.out, "Unknown command");
  for (
    const args of [
      ["pgcron", "register"],
      ["db", "cron", "status"],
      ["scheduler", "run"],
      ["instance", "kill"],
      ["fsm"],
      ["fsm", "unload"],
      ["config", "delete"],
      ["completion", "powershell"],
      ["scheduler", "status", "--bogus"],
      ["instance", "list", "--db-url", "postgresql://x@h/db"],
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
  const option = await pgfsmctl(["scheduler", "status", "--bogus"]);
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
  assertStringIncludes(out, "pg_cron job, through the API");
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

  const schedule = await pgfsmctl(["scheduler", "status", "--schedule", "1s"]);
  assertEquals(schedule.code, 2);
  assertStringIncludes(schedule.out, "--schedule is for scheduler register");
});

Deno.test("without an API configured, commands exit 2 naming --url and PGFSM_URL", async () => {
  for (
    const args of [
      ["instance", "stop", "-q", crypto.randomUUID()],
      ["instance", "list"],
      ["fsm", "list"],
      ["key", "list"],
      ["scheduler", "status"],
    ]
  ) {
    // A database URL around (as in a project's .env) changes nothing.
    const { code, out } = await pgfsmctl(args, {
      env: { DATABASE_URL: "postgresql://u@127.0.0.1:1/db" },
    });
    assertEquals(code, 2, args.join(" "));
    assertStringIncludes(out, "no API configured");
    assertStringIncludes(out, "--url");
    assertStringIncludes(out, "PGFSM_URL");
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
    assertStringIncludes(out, "no API configured");
  } finally {
    await Deno.remove(ok, { recursive: true });
  }
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
    for (const word of ["scheduler", "instance", "config", "input"]) {
      assertStringIncludes(stdout, word, `${shell}: ${word}`);
    }
  }
  const bash = (await pgfsmctl(["completion", "bash"])).stdout;
  assertStringIncludes(bash, 'scheduler) words="status register');
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

Deno.test("config: set/use/list/show; the API key only in a 0600 credentials.json", () =>
  withConfigDir(async (env, dir) => {
    assertEquals(
      (await pgfsmctl(["config", "set", "a", "--url", "not a url"], { env }))
        .code,
      2,
    );
    const gone = await pgfsmctl(
      ["config", "set", "a", "--db-url", "postgresql://u@h/db"],
      { env },
    );
    assertEquals(gone.code, 2, "--db-url is gone (SPEC-016)");

    const set = await pgfsmctl(
      ["config", "set", "a", "--url", "http://127.0.0.1:1/api/v1"],
      { env },
    );
    assertEquals(set.code, 0, set.out);
    const key = await pgfsmctl(
      ["config", "set", "a", "--api-key-stdin"],
      { env, stdin: "s3cret\n" },
    );
    assertEquals(key.code, 0, key.out);
    await pgfsmctl(["config", "set", "b", "--url", "https://api.example"], {
      env,
    });

    const yaml = await Deno.readTextFile(`${dir}/config.yaml`);
    assert(!yaml.includes("s3cret"), "no secret in config.yaml");
    assertStringIncludes(yaml, "current: a", "first profile becomes current");
    const creds = JSON.parse(
      await Deno.readTextFile(`${dir}/credentials.json`),
    );
    assertEquals(creds.profiles.a.api_key, "s3cret");
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
    assertEquals(shown.api_key, "set");
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

Deno.test("config: a profile from before SPEC-016 still works; set drops its db_url and tier", () =>
  withConfigDir(async (env, dir) => {
    await Deno.writeTextFile(
      `${dir}/config.yaml`,
      "current: old\nprofiles:\n  old:\n    url: http://127.0.0.1:1/api/v1\n    db_url: postgresql://u@h/db\n    tier: auto\n",
    );
    const shown = await pgfsmctl(["config", "show", "-o", "json"], { env });
    assertEquals(shown.code, 0, shown.out);
    assertEquals(JSON.parse(shown.stdout).url, "http://127.0.0.1:1/api/v1");
    await pgfsmctl(
      ["config", "set", "old", "--url", "http://127.0.0.1:2/api/v1"],
      { env },
    );
    const yaml = await Deno.readTextFile(`${dir}/config.yaml`);
    assert(!yaml.includes("db_url") && !yaml.includes("tier"), yaml);
  }));

// Which API a command picked, from its debug log. The ports are closed, so
// the command then fails to connect: only the choice is under test.
async function pickedTarget(
  args: string[],
  env: Record<string, string>,
): Promise<string> {
  const { stderr } = await pgfsmctl(args, {
    env: { ...env, PGFSMCTL_LOG_LEVEL: "debug" },
  });
  // "<url source> + key from <key source>" when they differ: the URL's.
  return /API from "?([^"\n]+?)(?: \+ key from [^"\n]+)?"?$/m.exec(stderr)
    ?.[1] ?? `none: ${stderr}`;
}

Deno.test("target precedence: --url > --profile/PGFSM_PROFILE > env > current profile", () =>
  withConfigDir(async (env) => {
    for (const [name, port] of [["cur", 1], ["other", 2]] as const) {
      await pgfsmctl(
        ["config", "set", name, "--url", `http://127.0.0.1:${port}/api/v1`],
        { env },
      );
      await pgfsmctl(["config", "set", name, "--api-key-stdin"], {
        env,
        stdin: `${name}-key`,
      });
    }
    await pgfsmctl(["config", "use", "cur"], { env });
    const list = ["instance", "list"];
    const apiEnv = {
      ...env,
      PGFSM_URL: "http://127.0.0.1:3/api/v1",
      PGFSM_API_KEY: "env-key",
    };

    assertEquals(await pickedTarget(list, env), "profile cur");
    assertEquals(await pickedTarget(list, apiEnv), "$PGFSM_URL");
    assertEquals(
      await pickedTarget([...list, "--profile", "other"], apiEnv),
      "profile other",
      "an explicit --profile beats PGFSM_URL",
    );
    assertEquals(
      await pickedTarget(list, { ...apiEnv, PGFSM_PROFILE: "other" }),
      "profile other",
    );
    assertEquals(
      await pickedTarget(
        [...list, "--url", "http://127.0.0.1:4/api/v1", "--api-key", "k"],
        apiEnv,
      ),
      "--url",
    );
    const ghost = await pgfsmctl([...list, "--profile", "ghost"], { env });
    assertEquals(ghost.code, 4);
  }));

Deno.test("pgfsmctl's source imports neither pg nor @pgfsm/db (SPEC-016)", async () => {
  const src = new URL("../src/", import.meta.url);
  const offenders: string[] = [];
  const walk = async (dir: URL) => {
    for await (const e of Deno.readDir(dir)) {
      const url = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
      if (e.isDirectory) await walk(url);
      else if (e.name.endsWith(".ts")) {
        const text = await Deno.readTextFile(url);
        if (
          /from\s+"(pg|@pgfsm\/db)(\/[^"]*)?"|import\(\s*"(pg|@pgfsm\/db)/
            .test(text)
        ) offenders.push(url.pathname);
      }
    }
  };
  await walk(src);
  assertEquals(offenders, []);
  // deno.json keeps pg for the tests (test/api-tier.test.ts mints keys); the
  // npm package is built from src/ only and depends on neither.
  const build = await Deno.readTextFile(
    new URL("../scripts/build-npm.ts", import.meta.url),
  );
  assert(
    !build.includes('"@pgfsm/db":'),
    "the npm build doesn't map @pgfsm/db",
  );
});
