import { parseArgs } from "@std/cli/parse-args";
import { basename, resolve } from "@std/path";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import { getLogger } from "@logtape/logtape";
import { configureLogging } from "@pgfsm/logging";
import { addFsm, FsmExistsError, MachineImportError } from "../commands/add.ts";
import {
  checkCreateTarget,
  checkProjectName,
  CreateError,
  createProject,
} from "../commands/create.ts";
import { goModTidy } from "../go-tidy.ts";
import { loadProject, NoProjectError, type ProjectConfig } from "../project.ts";
import { formatReport, WriteReport } from "../report.ts";
import { inSandbox } from "../sandbox.ts";
import { type Ask, resolveSources, SourceError } from "../source.ts";
import { PACKAGE_VERSION } from "../version.ts";

/** Exit codes, shared with pgfsmctl (SPEC-009 §6–7). */
const EXIT = {
  GENERAL: 1,
  USAGE: 2,
  NOT_FOUND: 4,
  INTERRUPTED: 130,
} as const;
const LOG_CATEGORY = "@pgfsm/cli";

const args = parseArgs(Deno.args, {
  string: ["fsm-name", "fsm-version", "name", "C"],
  boolean: ["help", "version", "dry-run", "force", "no-input", "verbose"],
  alias: { h: "help", v: "version", N: "fsm-name", V: "fsm-version" },
});

// The plan and next steps below are the CLI's UI, printed plainly. Logging
// (ADR-001: configured once, here) carries diagnostics only: the compiler's
// own step-by-step info logs are noise here unless --verbose.
await configureLogging({
  levels: {
    [LOG_CATEGORY]: "info",
    "@pgfsm/compiler": args.verbose ? "info" : "warning",
  },
});
const logger = getLogger([LOG_CATEGORY]);

const HELP = `pgfsm ${PACKAGE_VERSION} — create and grow FSM worker projects

USAGE
  npx @pgfsm/cli create <dir> [<source>] [--name <project>] [--dry-run]
  npx @pgfsm/cli add <source> [-N <fsm-name>] [-V <vNN>] [--force] [--dry-run]

  <source> is a folder of <fsmName>/<vNN>/{machine.ts|fsm.json}, a single
  machine.ts, or a single fsm.json.

COMMANDS
  create   Make <dir> with pgfsm.config.json, sync-worker/typescript and
           async-worker/{typescript,python,rust,go}, then add <source> if given.
           Run it from the parent directory; refuses an existing project.
  add      Add FSMs to the project around the current directory. Refuses an
           existing fsm/<name>/<vNN>/ unless --force, which is also how you
           regenerate one after editing its source. Never overwrites stubs.

OPTIONS
  -N, --fsm-name <name>     FSM name, for a single-file <source>
  -V, --fsm-version <vNN>   FSM version (v01, v02, ...), for a single-file <source>
      --name <project>      Project name for create (default: <dir>'s name)
  -C <dir>                  Use the project at <dir> instead of searching upward
      --dry-run             Show what would change; write nothing
      --force               Regenerate an existing fsm/<name>/<vNN>/
      --no-input            Never prompt; fail instead (default when not a terminal)
      --verbose             Show the compiler's own progress logs
  -v, --version             Print the version
  -h, --help                Show this help
`;

const interactive = !args["no-input"] && Deno.stdin.isTerminal();
const ask: Ask = async (question) => {
  if (!interactive) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(`${question} `);
  } finally {
    rl.close();
  }
};

function identityFlags() {
  return { name: args["fsm-name"], version: args["fsm-version"] };
}

function warnOnDrift(config: ProjectConfig): void {
  if (config.toolVersion !== PACKAGE_VERSION) {
    logger.warn(
      "This project was created with @pgfsm/cli {created}; you're running {running}. `npm run fsm:add` uses the pinned version.",
      { created: config.toolVersion, running: PACKAGE_VERSION },
    );
  }
}

/** Runs `fn` for real, or in a throwaway copy of `root` for --dry-run. */
async function run<T>(
  root: string,
  report: WriteReport,
  fn: (targetRoot: string) => Promise<T>,
): Promise<T> {
  if (!args["dry-run"]) return fn(root);
  return await inSandbox(root, async (sandboxRoot) => {
    const result = await fn(sandboxRoot);
    report.remap(sandboxRoot, root);
    return result;
  });
}

function printResult(root: string, report: WriteReport, title: string): void {
  console.log(args["dry-run"] ? `${title} (dry run — nothing written)` : title);
  console.log(formatReport(report, root));
  if (args["dry-run"]) return;
  const tidy = goModTidy(root);
  if (tidy === "no-go") {
    console.log(
      "\nGo isn't on PATH: run `go mod tidy` in async-worker/go before building the Go worker.",
    );
  } else if (tidy === "failed") {
    logger.warn(
      "`go mod tidy` failed in async-worker/go; run it there yourself before building the Go worker.",
    );
  }
}

async function cmdCreate(): Promise<void> {
  const [dirArg, source] = args._.slice(1).map(String);
  if (!dirArg) throw new CreateError("create needs a <dir>");
  const dir = resolve(dirArg);
  const name = args.name ?? basename(dir);
  checkProjectName(name);
  await checkCreateTarget(dir);
  const sources = source
    ? await resolveSources(source, Deno.cwd(), identityFlags(), ask)
    : [];

  const report = new WriteReport();
  await run(dir, report, (target) =>
    createProject({
      dir: target,
      name,
      toolVersion: PACKAGE_VERSION,
      sources,
      report,
    }));
  printResult(dir, report, `Created ${name} at ${dir}`);
  if (!args["dry-run"]) {
    console.log(`
Next:
  cd ${dirArg}
  npm run fsm:add -- <folder|machine.ts|fsm.json>   # add more FSMs
  cat README.md                                     # how to run each worker`);
  }
}

async function cmdAdd(): Promise<void> {
  const source = args._[1] === undefined ? undefined : String(args._[1]);
  if (!source) throw new SourceError("add needs a <source>");
  const project = await loadProject(args.C ? resolve(args.C) : Deno.cwd());
  console.log(`Using project: ${project.root}`);
  warnOnDrift(project.config);
  const sources = await resolveSources(
    source,
    Deno.cwd(),
    identityFlags(),
    ask,
  );

  const report = new WriteReport();
  await run(project.root, report, async (target) => {
    for (const s of sources) {
      await addFsm(target, s, { force: args.force, report });
    }
  });
  printResult(
    project.root,
    report,
    `Added ${sources.map((s) => `${s.name}/${s.version}`).join(", ")}`,
  );
}

const command = args._[0] === undefined ? undefined : String(args._[0]);
if (args.version) {
  console.log(PACKAGE_VERSION);
  Deno.exit(0);
}
if (args.help) {
  console.log(HELP);
  Deno.exit(0);
}
if (!command) {
  // Help on a usage error goes to stderr, like pgfsmctl (SPEC-009 §7).
  console.error(HELP);
  Deno.exit(EXIT.USAGE);
}

// Ctrl-C (also during an interactive prompt) exits 130.
Deno.addSignalListener("SIGINT", () => Deno.exit(EXIT.INTERRUPTED));

try {
  switch (command) {
    case "create":
      await cmdCreate();
      break;
    case "add":
      await cmdAdd();
      break;
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      Deno.exit(EXIT.USAGE);
  }
} catch (err) {
  // Expected, user-facing failures get their message only; anything else
  // gets the full error (with cause) through the logger.
  const code = exitCodeFor(err);
  if (code !== undefined) {
    console.error(`error: ${(err as Error).message}`);
  } else {
    logger.error("{command} failed: {error}", { command, error: err });
  }
  Deno.exit(code ?? EXIT.GENERAL);
}

/**
 * The exit code for an expected, user-facing error (SPEC-009 §7, the same
 * table as pgfsmctl's); undefined for an unexpected one (exit 1).
 */
function exitCodeFor(err: unknown): number | undefined {
  // Bad arguments: create's target or project name, a source that doesn't
  // exist or whose FSM identity can't be worked out.
  if (err instanceof CreateError || err instanceof SourceError) {
    return EXIT.USAGE;
  }
  if (err instanceof NoProjectError) return EXIT.NOT_FOUND;
  // A version that exists without --force, or a machine.ts that won't import.
  if (err instanceof FsmExistsError || err instanceof MachineImportError) {
    return EXIT.GENERAL;
  }
  return undefined;
}
