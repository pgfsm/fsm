/**
 * CLI integration tests — runs src/cli/index.ts as a subprocess.
 * Run from repo root: deno run --allow-all packages/fsm-compiler-ts/src/cli/index-test.ts
 */

import { getLogger } from "@logtape/logtape";
import { configureCompilerLogger } from "../logger.ts";

const logger = getLogger(["@pgfsm/compiler", "test"]);
await configureCompilerLogger();

const CLI = "packages/fsm-compiler-ts/src/cli/index.ts";
const FSM_FOLDER = "apps/fsm-core-example/fsm";

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
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
  logger.info("=== CLI Tests ===");

  // --help
  {
    const { code, stdout } = await runCli(["--help"]);
    logger.info("[--help] exit code: {code}", { code });
    if (code !== 0) logger.error("--help should exit 0");
    if (!stdout.includes("fsm-compiler")) {
      logger.error("--help should print usage");
    }
    if (!stdout.includes("generate")) {
      logger.error("--help should list generate command");
    }
    logger.info("[--help] done");
  }

  // no args → help
  {
    const { code, stdout } = await runCli([]);
    logger.info("[no args] exit code: {code}", { code });
    if (code !== 0) logger.error("no args should exit 0 with help");
    if (!stdout.includes("USAGE")) logger.error("no args should print USAGE");
    logger.info("[no args] done");
  }

  // missing folder
  {
    const { code, stderr } = await runCli(["generate"]);
    logger.info("[generate, no folder] exit code: {code}", { code });
    if (code !== 1) logger.error("missing folder should exit 1");
    if (!stderr.includes("--folder")) logger.error("should print folder error");
    logger.info("[generate, no folder] done");
  }

  // validate-sync-operation without --workflow-type
  {
    const { code, stderr } = await runCli([
      "validate-sync-operation",
      FSM_FOLDER,
    ]);
    logger.info(
      "[validate-sync-operation, no --workflow-type] exit code: {code}",
      {
        code,
      },
    );
    if (code !== 1) logger.error("missing --workflow-type should exit 1");
    if (!stderr.includes("--workflow-type")) {
      logger.error("should print workflow-type error");
    }
    logger.info("[validate-sync-operation, no --workflow-type] done");
  }

  // unknown command
  {
    const { code, stderr } = await runCli(["unknown-cmd", FSM_FOLDER]);
    logger.info("[unknown command] exit code: {code}", { code });
    if (code !== 1) logger.error("unknown command should exit 1");
    if (!stderr.includes("Unknown command")) {
      logger.error("should print unknown command error");
    }
    logger.info("[unknown command] done");
  }

  // generate — runs on example folder (no DB required)
  {
    const { code, stdout } = await runCli(["generate", FSM_FOLDER]);
    logger.info("[generate fsm] exit code: {code}", { code });
    logger.info("[generate fsm] stdout: {stdout}", {
      stdout: stdout.slice(0, 200),
    });
    if (code !== 0) logger.error("generate should succeed");
    logger.info("[generate fsm] done");
  }

  // generate-async-logic — runs on example folder (no DB required)
  {
    const { code } = await runCli(["generate-async-logic", FSM_FOLDER]);
    logger.info("[generate-async-logic fsm] exit code: {code}", { code });
    if (code !== 0) logger.error("generate-async-logic should succeed");
    logger.info("[generate-async-logic fsm] done");
  }

  // generate-sync-logic — runs on example folder (no DB required)
  {
    const { code } = await runCli([
      "generate-sync-logic",
      FSM_FOLDER,
      "--lang",
      "typescript",
    ]);
    logger.info("[generate-sync-logic fsm] exit code: {code}", { code });
    if (code !== 0) logger.error("generate-sync-logic should succeed");
    logger.info("[generate-sync-logic fsm] done");
  }

  // validate-sync-operation — runs on example folder (no DB required)
  {
    const { code } = await runCli([
      "validate-sync-operation",
      FSM_FOLDER,
      "--workflow-type",
      "fsm",
    ]);
    logger.info("[validate-sync-operation fsm] exit code: {code}", { code });
    if (code !== 0) logger.error("validate-sync-operation should succeed");
    logger.info("[validate-sync-operation fsm] done");
  }

  logger.info("=== CLI Tests complete ===");
})();
