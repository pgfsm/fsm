import { basename, join } from "@std/path";
import { isNotFoundError, scaffoldWorkerProjects } from "@pgfsm/compiler";
import {
  CONFIG_FILE_NAME,
  findProjectRoot,
  type ProjectConfig,
  writeConfig,
} from "../project.ts";
import type { WriteReport } from "../report.ts";
import type { ResolvedSource } from "../source.ts";
import { CTL_VERSION, GATEWAY_VERSION } from "../tool-versions.ts";
import { addFsm } from "./add.ts";

export class CreateError extends Error {}

/**
 * Files a fresh directory may already contain: `create .` right after
 * `git init` or a GitHub "new repo" should work.
 */
const ALLOWED_IN_TARGET = /^(\.git|\.gitignore|README(\..*)?|LICENSE(\..*)?)$/i;

/** xstate range the generated root deno.json maps, matching @pgfsm/compiler's own. */
const XSTATE_RANGE = "^5.19.4";

const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Refuses unsuitable targets before anything is written (SPEC-004): a
 * directory that is, or sits inside, a pgfsm project -- that's `add`'s job --
 * or one with unrelated files in it.
 */
export async function checkCreateTarget(dir: string): Promise<void> {
  const enclosing = await findProjectRoot(dir);
  if (enclosing) {
    throw new CreateError(
      enclosing === dir
        ? `${dir} is already a pgfsm project (it has ${CONFIG_FILE_NAME}). To add an FSM, run \`npx @pgfsm/cli add <source>\` there.`
        : `${dir} is inside the pgfsm project at ${enclosing}. To add an FSM, run \`npx @pgfsm/cli add <source>\` instead.`,
    );
  }
  try {
    const stray: string[] = [];
    for await (const e of Deno.readDir(dir)) {
      if (!ALLOWED_IN_TARGET.test(e.name)) stray.push(e.name);
    }
    if (stray.length > 0) {
      throw new CreateError(
        `${dir} isn't empty (${stray.slice(0, 5).join(", ")}${
          stray.length > 5 ? ", ..." : ""
        }). Pick a new directory name.`,
      );
    }
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }
}

export function checkProjectName(name: string): void {
  if (!PROJECT_NAME_RE.test(name)) {
    throw new CreateError(
      `Invalid project name "${name}": use lowercase letters, digits, ., - or _ (pass --name to choose one).`,
    );
  }
}

async function writeOwnFile(
  path: string,
  content: string,
  report: WriteReport,
): Promise<void> {
  await Deno.writeTextFile(path, content);
  report.ownFiles.push({ path, action: "created" });
}

function packageJson(name: string, toolVersion: string): string {
  // Scripts only -- no dependencies. Pinning the CLI version in the npx
  // call keeps add on the version that created the project without
  // installing it (SPEC-004 "Version pinning without a dependency"). The
  // gateway and pg_cron registration are pinned the same way (SPEC-005):
  // neither has user code, so they're config here, not project directories.
  // The gateway package ships two bins, hence its `-p ... --` form.
  const cli = `npx -y @pgfsm/cli@${toolVersion}`;
  return JSON.stringify(
    {
      name,
      private: true,
      scripts: {
        "fsm:add": `${cli} add`,
        "db:load": `npx -y @pgfsm/ctl@${CTL_VERSION} fsm load fsm`,
        "db:pgcron": `npx -y @pgfsm/ctl@${CTL_VERSION} db cron register`,
        "db:key":
          `npx -y @pgfsm/ctl@${CTL_VERSION} db key create --name local-admin --role admin`,
        "gateway":
          `npx -y -p @pgfsm/async-worker-gateway@${GATEWAY_VERSION} -- async-operation-worker-gateway --ensure-queue-on-register`,
      },
    },
    null,
    2,
  ) + "\n";
}

function rootDenoJson(): string {
  // Lets a machine.ts compile when pgfsm runs from this project under Deno
  // (`deno run -A npm:@pgfsm/cli`), wherever the machine.ts lives: Deno
  // resolves a dynamically imported file through the config found from the
  // working directory, so its `import ... from "xstate"` resolves through
  // this map. nodeModulesDir "auto" because package.json's presence would
  // otherwise switch Deno to a manual, never-installed node_modules.
  return JSON.stringify(
    {
      nodeModulesDir: "auto",
      imports: { xstate: `npm:xstate@${XSTATE_RANGE}` },
    },
    null,
    2,
  ) + "\n";
}

// SPEC-009 §7. `pgfsmctl` (npm run db:*) and the workers read these from
// .env in the directory they run in; .env itself is gitignored.
const ENV_EXAMPLE =
  `# Copy to .env (gitignored). Each tool reads .env from the directory it runs
# in: here for npm run db:* (pgfsmctl) and npm run gateway; the sync worker
# runs in sync-worker/typescript/, so copy it there too (or export the vars).

# Local development needs only the database. pgfsmctl prefers PGFSM_DB_URL
# over DATABASE_URL; the workers read DATABASE_URL.
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
# PGFSM_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres

# The pgfsm REST API (optional). With both set, \`npm run db:load\` loads through
# the API (an admin key, on an API started with --enable-admin-api) instead
# of straight into the database. The URL includes the API's path prefix.
# \`npm run db:key\` prints an admin key, once.
# PGFSM_URL=http://localhost:9999/fsm
# PGFSM_API_KEY=pgfsm_admin_...
`;

const GITIGNORE = `node_modules/
.env
.venv/
`;

function readme(name: string): string {
  return `# ${name}

A pgfsm project, created by \`@pgfsm/cli\`.

- \`fsm/<name>/<version>/\`: compiled FSM definitions (\`fsm.json\`).
- \`sync-worker/typescript/\`: actions, guards and delays.
- \`async-worker/{typescript,python,rust,go}/\`: actors, one project per language.

Stub files under the worker folders are yours to implement. Each action,
guard, delay and actor has its own, e.g.
\`sync-worker/typescript/<name>/<version>/guards/<guard>/<guard>.ts\`.
Re-running \`add\` never overwrites them, and creates a new stub for each
operation an FSM gains. Code shared by several operations can go in a sibling
module such as \`guards/_shared.ts\`.

## Add an FSM

\`\`\`bash
npm run fsm:add -- path/to/machine.ts --fsm-name checkout --fsm-version v01
npm run fsm:add -- path/to/fsm.json
npm run fsm:add -- path/to/folder/   # <fsmName>/<vNN>/{machine.ts|fsm.json}
\`\`\`

After editing a \`machine.ts\` or \`fsm.json\`, regenerate that FSM with the
same command plus \`--force\` (your stubs are kept):

\`\`\`bash
npm run fsm:add -- path/to/machine.ts --fsm-name checkout --fsm-version v01 --force
\`\`\`

A loaded FSM version is immutable: once \`npm run db:load\` has put it in a
database, changing its \`fsm.json\` means adding it again as a new version
(\`--fsm-version v02\`). The sync worker refuses to start while the database
holds a different definition than the one it was generated from.

## Run the stack

Copy \`.env.example\` to \`.env\` (it's gitignored), here and in
\`sync-worker/typescript/\`. Every command below reads \`DATABASE_URL\` from the
environment or from a \`.env\` in the directory it runs in; locally that's all
you need. Start them in this order, one terminal each:

\`\`\`bash
npm run db:load      # every deploy: loads fsm/ into the database (before the sync worker)
npm run db:pgcron    # once per database: registers the pg_cron scheduler job
npm run gateway      # Activity Gateway; async workers connect to it
cd sync-worker/typescript && deno task dev
cd async-worker/typescript && deno task start
cd async-worker/python && uv run run_async_worker.py start
cd async-worker/rust && cargo run --release -- start
cd async-worker/go && go run . start
\`\`\`

## With the pgfsm REST API

\`npm run db:key\` creates an admin API key straight in the database (once:
it's printed only then; only its hash is stored). Put it and the API's URL
in \`.env\` as \`PGFSM_API_KEY\` and \`PGFSM_URL\`: \`npm run db:load\` then loads
through the API instead of straight into the database. More keys, and
revoking them, go through the API: \`npx @pgfsm/ctl key create|list|revoke\`.
`;
}

export interface CreateOptions {
  /** Absolute project directory (created if missing). */
  dir: string;
  name: string;
  toolVersion: string;
  sources: ResolvedSource[];
  report: WriteReport;
}

/**
 * Creates a project: marker + project files, a runnable
 * `sync-worker/typescript` and all four `async-worker/<lang>` projects (empty
 * until an FSM uses that language), then adds `sources`. Returns the config
 * written.
 */
export async function createProject(
  opts: CreateOptions,
): Promise<ProjectConfig> {
  const { dir, name, toolVersion, report } = opts;
  await Deno.mkdir(dir, { recursive: true });

  const config: ProjectConfig = { name, toolVersion };
  await writeConfig(dir, config);
  report.ownFiles.push({
    path: join(dir, CONFIG_FILE_NAME),
    action: "created",
  });
  await writeOwnFile(
    join(dir, "package.json"),
    packageJson(name, toolVersion),
    report,
  );
  await writeOwnFile(join(dir, "deno.json"), rootDenoJson(), report);
  if (!(await fileExists(join(dir, ".gitignore")))) {
    await writeOwnFile(join(dir, ".gitignore"), GITIGNORE, report);
  }
  if (!(await fileExists(join(dir, ".env.example")))) {
    await writeOwnFile(join(dir, ".env.example"), ENV_EXAMPLE, report);
  }
  if (!(await fileExists(join(dir, "README.md")))) {
    await writeOwnFile(join(dir, "README.md"), readme(name), report);
  }

  await scaffoldWorkerProjects({
    writeRootAbsPath: dir,
    goModuleAppRoot: basename(dir),
    projectName: name,
    overwrite: "generated-only",
    onFileWrite: report.onFileWrite,
  });

  for (const source of opts.sources) {
    await addFsm(dir, source, { report });
  }
  return config;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
}
