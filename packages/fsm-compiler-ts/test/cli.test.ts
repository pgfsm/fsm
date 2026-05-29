import { assertEquals, assertStringIncludes } from "@std/assert";

const CLI = "packages/fsm-compiler-ts/src/cli/index.ts";
const FSM_FOLDER = "apps/fsm-core-example/fsm";
const SHARED_FSM_FOLDER = "apps/fsm-core-example/sharedFSM";

async function runCli(
  args: string[],
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", CLI, ...args],
    stdout: "piped",
    stderr: "piped",
    ...(env !== undefined && { env }),
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

// --- Help / no-args ---

Deno.test("cli --help exits 0 and prints usage", async () => {
  const { code, stdout } = await runCli(["--help"]);
  assertEquals(code, 0);
  assertStringIncludes(stdout, "fsm-compiler");
  assertStringIncludes(stdout, "USAGE");
  assertStringIncludes(stdout, "generate");
});

Deno.test("cli no args exits 0 and prints help", async () => {
  const { code, stdout } = await runCli([]);
  assertEquals(code, 0);
  assertStringIncludes(stdout, "USAGE");
});

Deno.test("cli -h shorthand exits 0", async () => {
  const { code } = await runCli(["-h"]);
  assertEquals(code, 0);
});

// --- Missing required args ---

Deno.test("cli generate without folder exits 1", async () => {
  const { code, stderr } = await runCli(["-c", "generate"]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "--folder");
});

Deno.test("cli validate-plugin without --workflow-type exits 1", async () => {
  const { code, stderr } = await runCli(["-c", "validate-plugin", "-f", FSM_FOLDER]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "--workflow-type");
});

Deno.test("cli load without --workflow-type exits 1", async () => {
  const { code, stderr } = await runCli(["-c", "load", "-f", FSM_FOLDER]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "--workflow-type");
});

Deno.test("cli load-and-validate without --workflow-type exits 1", async () => {
  const { code, stderr } = await runCli(["-c", "load-and-validate", "-f", FSM_FOLDER]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "--workflow-type");
});

Deno.test("cli unknown command exits 1", async () => {
  const { code, stderr } = await runCli(["-c", "unknown-cmd", "-f", FSM_FOLDER]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "Unknown command");
});

// --- Input validation ---

Deno.test("cli invalid --workflow-type exits 1", async () => {
  const { code, stderr } = await runCli(["-c", "validate-plugin", "-f", FSM_FOLDER, "-w", "foobar"]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "Invalid --workflow-type");
});

Deno.test("cli nonexistent --folder exits 1", async () => {
  const { code, stderr } = await runCli(["-c", "generate", "-f", "this/path/does/not/exist"]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "does not exist");
});

// --- generate ---

Deno.test("cli generate runs successfully on example folder", async () => {
  const { code } = await runCli(["-c", "generate", "-f", FSM_FOLDER]);
  assertEquals(code, 0);
});

Deno.test("cli generate with --show-recommendation exits 0", async () => {
  const { code } = await runCli(["-c", "generate", "-f", FSM_FOLDER, "--show-recommendation"]);
  assertEquals(code, 0);
});

Deno.test("cli generate with -r shorthand exits 0", async () => {
  const { code } = await runCli(["-c", "generate", "-f", FSM_FOLDER, "-r"]);
  assertEquals(code, 0);
});

// --- generate-plugin ---

Deno.test("cli generate-plugin runs successfully on example folder", async () => {
  const { code } = await runCli(["-c", "generate-plugin", "-f", FSM_FOLDER]);
  assertEquals(code, 0);
});

// --- delete ---

Deno.test("cli delete runs successfully on example folder", async () => {
  await runCli(["-c", "generate", "-f", FSM_FOLDER]);
  const { code } = await runCli(["-c", "delete", "-f", FSM_FOLDER]);
  assertEquals(code, 0);
  await runCli(["-c", "generate", "-f", FSM_FOLDER]); // restore generated files
});

// --- validate-plugin ---

Deno.test("cli validate-plugin runs successfully on example folder", async () => {
  const { code } = await runCli(["-c", "validate-plugin", "-f", FSM_FOLDER, "-w", "fsm"]);
  assertEquals(code, 0);
});

Deno.test("cli validate-plugin with -w shorthand exits 0", async () => {
  const { code } = await runCli(["-c", "validate-plugin", "-f", FSM_FOLDER, "-w", "fsm"]);
  assertEquals(code, 0);
});

// --- validate-promise-plugin ---

Deno.test("cli validate-promise-plugin runs on sharedFSM folder", async () => {
  const { code } = await runCli(["-c", "validate-promise-plugin", "-f", SHARED_FSM_FOLDER, "-w", "sharedPromise"]);
  assertEquals(code, 0);
});

// --- DB-dependent commands (test flag parsing and early validation, no real DB required) ---

Deno.test("cli load without db connection string exits 1", async () => {
  const { code, stderr } = await runCli(
    ["-c", "load", "-f", FSM_FOLDER, "-w", "fsm"],
    { DATABASE_URL: "" },
  );
  assertEquals(code, 1);
  assertStringIncludes(stderr, "No database connection string");
});

Deno.test("cli --db-url flag is accepted and parsed", async () => {
  // With --db-url provided, buildDeps() should not print "No database connection string".
  // The connection itself will fail later (port 1 is not a DB), but the flag must be parsed.
  const { stderr } = await runCli(
    ["-c", "load", "-f", FSM_FOLDER, "-w", "fsm", "--db-url", "postgresql://localhost:1/test"],
    { DATABASE_URL: "" },
  );
  const isParseError = stderr.includes("No database connection string");
  assertEquals(isParseError, false);
});

// --- Flag acceptance tests ---

Deno.test("cli --skip-dirs flag is accepted", async () => {
  const { code } = await runCli(["-c", "generate", "-f", FSM_FOLDER, "--skip-dirs", "nonexistent"]);
  assertEquals(code, 0);
});

Deno.test("cli --available-actors flag is accepted", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(tmpFile, "[]");
  try {
    const { code } = await runCli(["-c", "validate-plugin", "-f", FSM_FOLDER, "-w", "fsm", "--available-actors", tmpFile]);
    assertEquals(code, 0);
  } finally {
    await Deno.remove(tmpFile);
  }
});
