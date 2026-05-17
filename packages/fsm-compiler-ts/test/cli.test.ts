import { assertEquals, assertStringIncludes } from "@std/assert";

const CLI = "packages/fsm-compiler-ts/src/cli/index.ts";
const FSM_FOLDER = "apps/fsm-core-example/fsm";

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", CLI, ...args],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

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

Deno.test("cli generate without folder exits 1", async () => {
  const { code, stderr } = await runCli(["generate"]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "<folder>");
});

Deno.test("cli validate without --workflow-type exits 1", async () => {
  const { code, stderr } = await runCli(["validate", FSM_FOLDER]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "--workflow-type");
});

Deno.test("cli load without --workflow-type exits 1", async () => {
  const { code, stderr } = await runCli(["load", FSM_FOLDER]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "--workflow-type");
});

Deno.test("cli load-and-verify without --workflow-type exits 1", async () => {
  const { code, stderr } = await runCli(["load-and-verify", FSM_FOLDER]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "--workflow-type");
});

Deno.test("cli unknown command exits 1", async () => {
  const { code, stderr } = await runCli(["unknown-cmd", FSM_FOLDER]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "Unknown command");
});

Deno.test("cli generate runs successfully on example folder", async () => {
  const { code } = await runCli(["generate", FSM_FOLDER]);
  assertEquals(code, 0);
});

Deno.test("cli generate with --show-recommendation exits 0", async () => {
  const { code } = await runCli(["generate", FSM_FOLDER, "--show-recommendation"]);
  assertEquals(code, 0);
});

Deno.test("cli generate with -r shorthand exits 0", async () => {
  const { code } = await runCli(["generate", FSM_FOLDER, "-r"]);
  assertEquals(code, 0);
});

Deno.test("cli validate runs successfully on example folder", async () => {
  const { code } = await runCli(["validate", FSM_FOLDER, "--workflow-type", "fsm"]);
  assertEquals(code, 0);
});

Deno.test("cli validate with -w shorthand exits 0", async () => {
  const { code } = await runCli(["validate", FSM_FOLDER, "-w", "fsm"]);
  assertEquals(code, 0);
});
