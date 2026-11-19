// Docker helpers for the install test (compare-pgext-and-fullsqlscript.ts): the install-test image (postgres:<pg> with
// pg_cron and pgmq), throwaway containers, psql inside them, and the
// `installer` login a plain-SQL install runs as (it owns the database but
// isn't a superuser, as on managed Postgres).

const root = new URL("../", import.meta.url);

export async function run(
  cmd: string,
  argv: string[],
  opts: { stdin?: string; cwd?: URL } = {},
): Promise<string> {
  const p = new Deno.Command(cmd, {
    args: argv,
    cwd: opts.cwd,
    stdin: opts.stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (opts.stdin !== undefined) {
    const w = p.stdin.getWriter();
    try {
      await w.write(new TextEncoder().encode(opts.stdin));
      await w.close();
    } catch (e) {
      // psql stops reading at the first error; its exit status says why.
      if (!(e instanceof Deno.errors.BrokenPipe)) throw e;
    }
  }
  const out = await p.output();
  const stdout = new TextDecoder().decode(out.stdout);
  const stderr = new TextDecoder().decode(out.stderr);
  if (!out.success) {
    throw new Error(`${cmd} ${argv.join(" ")} failed:\n${stderr || stdout}`);
  }
  return stdout;
}

/**
 * Runs `sql` with psql in the container, in one transaction, stopping at the
 * first error: as the superuser, or as `user` (password = name) when given.
 */
export function psql(
  container: string,
  sql: string,
  user?: string,
): Promise<string> {
  const login = user
    ? [
      "-e",
      `PGPASSWORD=${user}`,
      container,
      "psql",
      "-h",
      "127.0.0.1",
      "-U",
      user,
    ]
    : [container, "psql", "-U", "postgres"];
  return run("docker", [
    "exec",
    "-i",
    ...login,
    "-d",
    "postgres",
    "-X",
    "-q",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-1",
  ], { stdin: sql });
}

/** Builds pgfsm-install-test:<pg> from install-test/Dockerfile. */
export async function buildImage(pg: string): Promise<string> {
  const image = `pgfsm-install-test:${pg}`;
  console.log(`Building ${image}`);
  await run("docker", [
    "build",
    "-q",
    "--build-arg",
    `PG_MAJOR=${pg}`,
    "-t",
    image,
    ".",
  ], { cwd: new URL("install-test/", root) });
  return image;
}

/** Starts a fresh container (replacing one of that name) and waits for it. */
export async function startPostgres(
  image: string,
  name: string,
  port: number,
): Promise<void> {
  await run("docker", ["rm", "-f", name]).catch(() => {});
  await run("docker", [
    "run",
    "-d",
    "--name",
    name,
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-p",
    `127.0.0.1:${port}:5432`,
    image,
  ]);
  // The entrypoint restarts the server once after initdb: wait for a real
  // query over TCP.
  for (let i = 0; i < 60; i++) {
    try {
      await run("docker", [
        "exec",
        name,
        "psql",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
        "-Atc",
        "select 1",
      ]);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`${name} didn't start`);
}

/**
 * The `installer` login (password `installer`) a plain-SQL install runs as:
 * the database's owner with CREATEROLE, not a superuser. The admin creates
 * pg_cron and lets it use the cron schema, as a managed provider does.
 */
export async function createInstaller(container: string): Promise<void> {
  await psql(
    container,
    `CREATE ROLE installer LOGIN PASSWORD 'installer' CREATEROLE;
     ALTER DATABASE postgres OWNER TO installer;
     CREATE EXTENSION pg_cron;
     GRANT USAGE ON SCHEMA cron TO installer;
     GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA cron TO installer;
     GRANT SELECT ON cron.job TO installer;`,
  );
}

export const url = (port: number, user = "postgres") =>
  `postgresql://${user}:${user}@127.0.0.1:${port}/postgres`;

export async function removeContainers(names: string[]): Promise<void> {
  for (const c of names) await run("docker", ["rm", "-f", c]).catch(() => {});
}
