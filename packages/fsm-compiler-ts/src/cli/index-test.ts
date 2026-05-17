/**
 * CLI integration tests — runs src/cli/index.ts as a subprocess.
 * Run from repo root: deno run --allow-all packages/fsm-compiler-ts/src/cli/index-test.ts
 */

const CLI = "packages/fsm-compiler-ts/src/cli/index.ts";
const FSM_FOLDER = "apps/fsm-core-example/fsm";
const SHARED_FSM_FOLDER = "apps/fsm-core-example/sharedFSM";

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

(async () => {
  console.log("=== CLI Tests ===\n");

  // --help
  {
    const { code, stdout } = await runCli(["--help"]);
    console.log("[--help] exit code:", code);
    console.assert(code === 0, "--help should exit 0");
    console.assert(stdout.includes("fsm-compiler"), "--help should print usage");
    console.assert(stdout.includes("generate"), "--help should list generate command");
    console.log("[--help] ✅\n");
  }

  // no args → help
  {
    const { code, stdout } = await runCli([]);
    console.log("[no args] exit code:", code);
    console.assert(code === 0, "no args should exit 0 with help");
    console.assert(stdout.includes("USAGE"), "no args should print USAGE");
    console.log("[no args] ✅\n");
  }

  // missing folder
  {
    const { code, stderr } = await runCli(["generate"]);
    console.log("[generate, no folder] exit code:", code);
    console.assert(code === 1, "missing folder should exit 1");
    console.assert(stderr.includes("<folder>"), "should print folder error");
    console.log("[generate, no folder] ✅\n");
  }

  // validate without --workflow-type
  {
    const { code, stderr } = await runCli(["validate", FSM_FOLDER]);
    console.log("[validate, no --workflow-type] exit code:", code);
    console.assert(code === 1, "missing --workflow-type should exit 1");
    console.assert(stderr.includes("--workflow-type"), "should print workflow-type error");
    console.log("[validate, no --workflow-type] ✅\n");
  }

  // unknown command
  {
    const { code, stderr } = await runCli(["unknown-cmd", FSM_FOLDER]);
    console.log("[unknown command] exit code:", code);
    console.assert(code === 1, "unknown command should exit 1");
    console.assert(stderr.includes("Unknown command"), "should print unknown command error");
    console.log("[unknown command] ✅\n");
  }

  // generate — runs on example folder (no DB required)
  {
    const { code, stdout } = await runCli(["generate", FSM_FOLDER]);
    console.log("[generate fsm] exit code:", code);
    console.log("[generate fsm] stdout:", stdout.slice(0, 200));
    console.assert(code === 0, "generate should succeed");
    console.log("[generate fsm] ✅\n");
  }

  // generate-plugin — runs on example folder (no DB required)
  {
    const { code } = await runCli(["generate-plugin", FSM_FOLDER]);
    console.log("[generate-plugin fsm] exit code:", code);
    console.assert(code === 0, "generate-plugin should succeed");
    console.log("[generate-plugin fsm] ✅\n");
  }

  // validate — runs on example folder (no DB required)
  {
    const { code } = await runCli(["validate", FSM_FOLDER, "--workflow-type", "fsm"]);
    console.log("[validate fsm] exit code:", code);
    console.assert(code === 0, "validate should succeed");
    console.log("[validate fsm] ✅\n");
  }

  console.log("=== CLI Tests complete ===");
})();
