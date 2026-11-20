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
import {
  API_VERSION,
  CTL_VERSION,
  FSM_CORE_VERSION,
  GATEWAY_VERSION,
} from "../tool-versions.ts";
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
  // installing it (SPEC-004 "Version pinning without a dependency"). The API,
  // pgfsmctl and the gateway are pinned the same way (SPEC-005, SPEC-016):
  // none has user code, so they're config here, not project directories.
  // The gateway package ships two bins, hence its `-p ... --` form.
  const cli = `npx -y @pgfsm/cli@${toolVersion}`;
  const api = `npx -y @pgfsm/api@${API_VERSION}`;
  return JSON.stringify(
    {
      name,
      private: true,
      scripts: {
        "fsm:add": `${cli} add`,
        "api": `${api} --enable-admin-api`,
        "api:key": `${api} key bootstrap --name local-admin`,
        "db:load": `npx -y @pgfsm/ctl@${CTL_VERSION} fsm load fsm`,
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
# in: here for npm run api, api:key, db:load and gateway; the sync worker
# runs in sync-worker/typescript/, so copy it there too (or export the vars).

# The database, with fsm_core installed: the API, the gateway and the workers
# read it. Locally its owner works for all of them.
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres

# The pgfsm API (docker compose's api service, or \`npm run api\`), which
# pgfsmctl (\`npm run db:load\`) talks to; the URL includes its path prefix.
# \`npm run api:key\` prints the first admin key, once: put it here.
PGFSM_URL=http://localhost:9999/api/v1
# PGFSM_API_KEY=pgfsm_admin_...

# The Activity Gateway (docker compose's gateway service), which the async
# workers connect to: plaintext TCP, for local use only.
PGFSM_GATEWAY_ADDRESS=http://127.0.0.1:7443
`;

/** A Compose project name: lowercase letters, digits, - and _ only. */
function composeProjectName(name: string): string {
  return name.replace(/[^a-z0-9_-]/g, "-");
}

// SPEC-016: the local stack. Postgres is built here (db/Dockerfile), not
// pulled; the API and the gateway are released images, pinned like the npm
// scripts. Workers run on the host and reach these through the published
// ports, which listen on 127.0.0.1 only.
function dockerCompose(name: string): string {
  return `# The local pgfsm stack (SPEC-016), created by @pgfsm/cli: Postgres with
# fsm_core installed, the pgfsm API and the Activity Gateway. Your sync and
# async workers run on the host (README.md, "Run the stack").
#
#   docker compose up -d --build --wait
#
# The database lives in the db-data volume: \`docker compose down -v\` deletes
# it, and the next \`up\` installs fsm_core afresh. Ports listen on 127.0.0.1.
name: ${composeProjectName(name)}

services:
  db:
    build:
      context: ./db
      args:
        FSM_CORE_VERSION: "${FSM_CORE_VERSION}"
    # pg_cron runs fsm_core's scheduler job (fsm_schedule_all_pending).
    command:
      - postgres
      - -c
      - shared_preload_libraries=pg_cron
      - -c
      - cron.database_name=postgres
    environment:
      POSTGRES_PASSWORD: postgres
    ports:
      - "127.0.0.1:54322:5432"
    volumes:
      - db-data:/var/lib/postgresql/data
    # Healthy once the server accepts TCP (initdb's temporary server doesn't)
    # and fsm_core is installed.
    healthcheck:
      test:
        - CMD-SHELL
        - psql -h 127.0.0.1 -U postgres -tAc 'select fsm_core.version()'
      interval: 2s
      timeout: 5s
      retries: 90

  api:
    image: ghcr.io/pgfsm/api:${API_VERSION}
    # The admin routes (FSM load, API keys, the scheduler): local use.
    command: ["--port=9999", "--enable-admin-api"]
    environment:
      DATABASE_URL: postgresql://postgres:postgres@db:5432/postgres
    ports:
      - "127.0.0.1:9999:9999"
    depends_on:
      db:
        condition: service_healthy

  gateway:
    image: ghcr.io/pgfsm/async-worker-gateway:${GATEWAY_VERSION}
    # Plaintext TCP without a token: local use only (PGFSM_GATEWAY_ADDRESS).
    command:
      - --sidecar-listen=tcp://0.0.0.0:7443
      - --insecure-plaintext
      - --ensure-queue-on-register
    environment:
      DATABASE_URL: postgresql://postgres:postgres@db:5432/postgres
    ports:
      - "127.0.0.1:7443:7443"
    depends_on:
      db:
        condition: service_healthy

volumes:
  db-data:
`;
}

function dbDockerfile(): string {
  return `# Postgres for the local pgfsm stack (SPEC-016), created by @pgfsm/cli:
# postgres:16, PGDG's pg_cron, pgmq (SQL-only, from its source release) and
# fsm_core's install SQL, which 10-fsm-core.sh runs once, when the db-data
# volume is empty.
#
# The install SQL is db/fsm_core--<FSM_CORE_VERSION>.sql when that file is
# here (offline, or a build of your own); otherwise it's downloaded from the
# fsm_core-v<FSM_CORE_VERSION> GitHub release and checked against the
# release's SHA256SUMS.
ARG PG_MAJOR=16

FROM postgres:\${PG_MAJOR} AS pgmq
ARG PGMQ_VERSION=1.4.4
ADD https://github.com/pgmq/pgmq/archive/refs/tags/v\${PGMQ_VERSION}.tar.gz /tmp/pgmq.tar.gz
RUN set -eux; \\
  src="/tmp/pgmq-\${PGMQ_VERSION}/pgmq-extension"; \\
  tar xzf /tmp/pgmq.tar.gz -C /tmp; \\
  mkdir -p /out; \\
  cp "\$src/pgmq.control" "\$src"/sql/*--*.sql /out/; \\
  cp "\$src/sql/pgmq.sql" "/out/pgmq--\${PGMQ_VERSION}.sql"

FROM postgres:\${PG_MAJOR} AS fsm-core
ARG FSM_CORE_VERSION
COPY . /tmp/db/
RUN set -eux; \\
  f="fsm_core--\${FSM_CORE_VERSION}.sql"; \\
  mkdir -p /out; \\
  if [ -f "/tmp/db/\$f" ]; then \\
    cp "/tmp/db/\$f" /out/fsm_core.sql; \\
  else \\
    apt-get update; \\
    apt-get install -y --no-install-recommends ca-certificates curl; \\
    base="https://github.com/pgfsm/fsm/releases/download/fsm_core-v\${FSM_CORE_VERSION}"; \\
    cd /tmp; \\
    hint="is fsm_core \${FSM_CORE_VERSION} released? To build without the download, put \$f in db/ (README.md, Run the stack)"; \\
    curl -fsSL -o "\$f" "\$base/\$f" \\
      || { echo "Can't download \$f from \$base: \$hint" >&2; exit 1; }; \\
    curl -fsSL -o SHA256SUMS "\$base/SHA256SUMS" \\
      || { echo "Can't download SHA256SUMS from \$base: \$hint" >&2; exit 1; }; \\
    awk -v f="\$f" '\$2 == f' SHA256SUMS | sha256sum -c -; \\
    cp "\$f" /out/fsm_core.sql; \\
  fi

FROM postgres:\${PG_MAJOR}
ARG PG_MAJOR
RUN apt-get update \\
  && apt-get install -y --no-install-recommends postgresql-\${PG_MAJOR}-cron \\
  && rm -rf /var/lib/apt/lists/*
COPY --from=pgmq /out/ /usr/share/postgresql/\${PG_MAJOR}/extension/
COPY --from=fsm-core /out/fsm_core.sql /opt/fsm_core/fsm_core.sql
COPY 10-fsm-core.sh /docker-entrypoint-initdb.d/
`;
}

// Run by the postgres image's entrypoint on first start only (an empty data
// volume), as the superuser, in the database POSTGRES_DB names.
const DB_INIT_SCRIPT = `#!/bin/sh
# Installs fsm_core (SPEC-016) when initdb creates the database, in one
# transaction: an error leaves nothing half-installed, and the container stops.
set -e
psql -v ON_ERROR_STOP=1 -1 --no-psqlrc \\
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \\
  -f /opt/fsm_core/fsm_core.sql
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

\`docker-compose.yml\` runs Postgres with fsm_core installed (and its pg_cron
scheduler job), the pgfsm API and the Activity Gateway; your workers run on the
host. You need Docker, not Supabase. Copy \`.env.example\` to \`.env\` (it's
gitignored), here and in \`sync-worker/typescript/\`: every command below reads
it from the directory it runs in.

\`\`\`bash
docker compose up -d --build --wait   # first time: builds the Postgres image (db/)
npm run api:key      # once per database: prints the first admin key; put it in .env as PGFSM_API_KEY
npm run db:load      # every deploy: loads fsm/ through the API (before the sync worker)
cd sync-worker/typescript && deno task dev
cd async-worker/typescript && deno task start
cd async-worker/python && uv run run_async_worker.py start
cd async-worker/rust && cargo run --release -- start
cd async-worker/go && go run . start
\`\`\`

The async workers reach the gateway through \`PGFSM_GATEWAY_ADDRESS\`.
\`docker compose down\` stops the stack; \`down -v\` also deletes the database.
\`db/Dockerfile\` downloads fsm_core's install SQL from its GitHub release; to
build offline, put \`fsm_core--<version>.sql\` in \`db/\` first.

Without Docker, use any Postgres 15+ with ltree, pg_cron and pgmq: install
fsm_core there (the \`fsm_core--<version>.sql\` release asset, or the PGXN
extension), point \`DATABASE_URL\` at it, and run \`npm run api\` and
\`npm run gateway\` instead of the compose services.

## API keys

\`npm run api:key\` creates the first admin API key, as the database owner
(once: it's printed only then; only its hash is stored, and it refuses while
an admin key exists). More keys, and revoking them, go through the API:
\`npx @pgfsm/ctl key create|list|revoke\`. The scheduler's pg_cron job:
\`npx @pgfsm/ctl scheduler status\`.
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
  await writeOwnFile(
    join(dir, "docker-compose.yml"),
    dockerCompose(name),
    report,
  );
  await Deno.mkdir(join(dir, "db"), { recursive: true });
  await writeOwnFile(join(dir, "db", "Dockerfile"), dbDockerfile(), report);
  await writeOwnFile(join(dir, "db", "10-fsm-core.sh"), DB_INIT_SCRIPT, report);
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
