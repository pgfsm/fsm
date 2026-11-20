#!/usr/bin/env -S deno run --allow-all
// End-to-end test of the local stack `pgfsm create` generates (SPEC-016,
// #691), from this checkout's source:
//
//   deno run --allow-all packages/fsm-cli-ts/scripts/compose-e2e.ts \
//     --install-sql <fsm_core--<v>.sql> [--alt-ports] [--keep]
//
// 1. builds the API and gateway images from source, tagged with the names and
//    versions the generated docker-compose.yml pins, so `up` uses them instead
//    of pulling (--no-build-images skips this: use the released images);
// 2. `pgfsm create`s a project with one FSM (spec013Child v01, which invokes nothing), and puts the
//    plain-SQL install in its db/ (db/Dockerfile prefers it to downloading the
//    fsm_core release; without --install-sql it downloads);
// 3. `docker compose up -d --build --wait`;
// 4. `key bootstrap` (the API image's), `pgfsmctl config set`,
//    `pgfsmctl fsm load fsm`, `instance create`, `instance get` and
//    `scheduler status`: each must succeed.
//
// Run from the repository root. --alt-ports publishes the services on 55432,
// 59999 and 57443 (rewritten in the project's compose file), for machines
// where the local Supabase holds 54322. pgfsmctl's profile goes to a throwaway PGFSM_CONFIG_DIR. The
// stack is removed (`down -v`) at the end unless --keep.

import { parseArgs } from "@std/cli/parse-args";
import { join, resolve } from "@std/path";
import {
  API_VERSION,
  FSM_CORE_VERSION,
  GATEWAY_VERSION,
} from "../src/tool-versions.ts";

const args = parseArgs(Deno.args, {
  string: ["install-sql"],
  boolean: ["alt-ports", "keep", "build-images", "help"],
  default: { "build-images": true },
  negatable: ["build-images"],
});
if (args.help) {
  console.log(
    "Usage: compose-e2e.ts [--install-sql <file>] [--alt-ports] [--keep] [--no-build-images]",
  );
  Deno.exit(0);
}

const repo = resolve(".");
const ports = args["alt-ports"]
  ? { db: 55432, api: 59999, gateway: 57443 }
  : { db: 54322, api: 9999, gateway: 7443 };
const apiImage = `ghcr.io/pgfsm/api:${API_VERSION}`;
const gatewayImage = `ghcr.io/pgfsm/async-worker-gateway:${GATEWAY_VERSION}`;

async function run(
  cmd: string,
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string>; stdin?: string } = {},
): Promise<string> {
  console.log(`\n$ ${cmd} ${argv.join(" ")}`);
  const p = new Deno.Command(cmd, {
    args: argv,
    cwd: opts.cwd ?? repo,
    env: opts.env,
    stdin: opts.stdin === undefined ? "inherit" : "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  if (opts.stdin !== undefined) {
    const w = p.stdin.getWriter();
    await w.write(new TextEncoder().encode(opts.stdin));
    await w.close();
  }
  const out = await p.output();
  const stdout = new TextDecoder().decode(out.stdout);
  if (stdout.trim()) console.log(stdout.trimEnd());
  if (!out.success) {
    throw new Error(`${cmd} ${argv[0]} failed (exit ${out.code})`);
  }
  return stdout;
}

const work = await Deno.makeTempDir({ prefix: "pgfsm-compose-e2e-" });
const project = join(work, "compose-e2e");
const configDir = join(work, "pgfsmctl");
const compose = ["compose", "-f", "docker-compose.yml"];
let up = false;

try {
  // ── 1. The API and gateway images, from source ───────────────────────────
  if (args["build-images"]) {
    await run("docker", [
      "build",
      "-f",
      "packages/fsm-api-ts/deploy/docker/api.Dockerfile",
      "--build-arg",
      `VERSION=${API_VERSION}`,
      "-t",
      apiImage,
      ".",
    ]);
    await run("docker", [
      "build",
      "-f",
      "packages/fsm-async-worker-gateway-ts/deploy/docker/gateway.Dockerfile",
      "--build-arg",
      `VERSION=${GATEWAY_VERSION}`,
      "-t",
      gatewayImage,
      ".",
    ]);
  }

  // ── 2. A project, with fsm_core's install SQL in db/ ─────────────────────
  await run("deno", [
    "run",
    "--allow-all",
    "packages/fsm-cli-ts/src/cli/pgfsm.ts",
    "create",
    project,
    "--name",
    "compose-e2e",
    "apps/fsm-core-example/fsm/spec013Child/v01/fsm.json",
  ], { env: { PGFSM_SKIP_GO_TIDY: "1" } });
  if (args["install-sql"]) {
    await Deno.copyFile(
      args["install-sql"],
      join(project, "db", `fsm_core--${FSM_CORE_VERSION}.sql`),
    );
  }
  if (args["alt-ports"]) {
    // Rewrites the published ports in this throwaway copy (an override file
    // would need Compose 2.24+'s !override to replace, not add, them).
    const file = join(project, "docker-compose.yml");
    let yml = await Deno.readTextFile(file);
    for (
      const [from, to] of [
        ["127.0.0.1:54322:", `127.0.0.1:${ports.db}:`],
        ["127.0.0.1:9999:", `127.0.0.1:${ports.api}:`],
        ["127.0.0.1:7443:", `127.0.0.1:${ports.gateway}:`],
      ]
    ) {
      if (!yml.includes(from)) throw new Error(`no ${from} in ${file}`);
      yml = yml.replaceAll(from, to);
    }
    await Deno.writeTextFile(file, yml);
  }

  // ── 3. The stack ──────────────────────────────────────────────────────────
  up = true;
  await run("docker", [...compose, "up", "-d", "--build", "--wait"], {
    cwd: project,
  });

  // ── 4. Key, profile, load, create ────────────────────────────────────────
  const key = (await run("docker", [
    ...compose,
    "run",
    "--rm",
    "--no-deps",
    "api",
    "key",
    "bootstrap",
    "--db-url",
    "postgresql://postgres:postgres@db:5432/postgres",
    "--name",
    "compose-e2e",
  ], { cwd: project })).trim().split("\n").pop()!;
  if (!key.startsWith("pgfsm_")) throw new Error(`no API key in: ${key}`);

  const ctlEnv = { PGFSM_CONFIG_DIR: configDir };
  const ctl = (argv: string[], stdin?: string) =>
    run("deno", [
      "run",
      "--allow-all",
      join(repo, "packages/fsm-ctl-ts/src/cli/pgfsmctl.ts"),
      ...argv,
    ], { cwd: project, env: ctlEnv, stdin });
  await ctl([
    "config",
    "set",
    "local",
    "--url",
    `http://127.0.0.1:${ports.api}/api/v1`,
    "--api-key-stdin",
    "--use",
  ], key);
  await ctl(["fsm", "load", "fsm"]);
  const created = await ctl([
    "instance",
    "create",
    "-n",
    "spec013Child",
    "-V",
    "v01",
    "-o",
    "ids",
  ]);
  const queue = created.trim().split("\n").pop()!;
  await ctl(["instance", "get", "-q", queue]);
  const scheduler = await ctl(["scheduler", "status"]);
  if (!/fsm_schedule_all_pending/.test(scheduler)) {
    throw new Error("the scheduler's pg_cron job isn't registered");
  }
  console.log(
    `\ncompose-e2e: the generated stack works (fsm_core ${FSM_CORE_VERSION}, api ${API_VERSION}, gateway ${GATEWAY_VERSION}).`,
  );
} catch (err) {
  console.error(`\ncompose-e2e failed: ${(err as Error).message}`);
  if (up) {
    await run("docker", [...compose, "logs", "--no-color", "--tail", "80"], {
      cwd: project,
    }).catch(() => {});
  }
  Deno.exitCode = 1;
} finally {
  if (args.keep) {
    console.log(
      `Kept: ${project} (docker compose ${compose.slice(1).join(" ")})`,
    );
  } else {
    if (up) {
      await run("docker", [...compose, "down", "-v"], { cwd: project })
        .catch(() => {});
    }
    await Deno.remove(work, { recursive: true }).catch(() => {});
  }
}
