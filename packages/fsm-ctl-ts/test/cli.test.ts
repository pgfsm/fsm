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
  for (const noun of ["pgcron", "instance", "scheduler"]) {
    assertStringIncludes(help.out, noun);
  }
  assertEquals((await pgfsmctl([])).code, 1);
});

Deno.test("unknown noun and unknown verbs exit 1", async () => {
  const noun = await pgfsmctl(["fsmctl"]);
  assertEquals(noun.code, 1);
  assertStringIncludes(noun.out, "Unknown command");
  for (const args of [["pgcron"], ["pgcron", "drop"], ["instance", "kill"]]) {
    const { code } = await pgfsmctl(args);
    assertEquals(code, 1, args.join(" "));
  }
  const scheduler = await pgfsmctl(["scheduler", "start"]);
  assertEquals(scheduler.code, 1);
  assertStringIncludes(scheduler.out, "Unknown scheduler verb");
});

Deno.test("each noun has its own --help", async () => {
  for (const noun of ["pgcron", "instance", "scheduler"]) {
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
