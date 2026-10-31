// SPEC-007's process-level E2E (#458): the activity tier as real processes,
// no cluster. The Activity Gateway CLI from repository source listens on TCP
// with TLS and one bearer token per language (--auth-token-dir, like the
// reference manifests), and this project's four async workers (each on its
// published SDK) connect to it over https. Load is load.ts's direct
// `enqueue`: messages straight onto each language's loadWork queue.
//
// The steps share one stack, in order:
//
// 1. Core flow: every worker registers with its own token, and a round of
//    load per language is processed exactly once.
// 2. Auth: a worker with a wrong token, and one with none, is refused before
//    registering (UNAUTHENTICATED ends it); plaintext to the TLS listener
//    fails; a token added to the directory is accepted and, once removed,
//    refused, all without restarting the gateway.
// 3. Connections bounded: the gateway's Postgres backends stay within its
//    pool max at 1 and at 3 TypeScript workers. Workers run without any
//    database settings, so the gateway's are the activity tier's only ones.
// 4. Gateway restart under load: stopped with SIGTERM, then killed with
//    SIGKILL, mid-load, and started again on the same port. Every worker
//    re-registers without restarting, and no message is lost.
//
// The cluster-only criteria (throughput scaling with replicas, a rolling
// restart of a Deployment, half-open connections) are the kind suite's.
//
// Needs DATABASE_URL (Postgres with the fsm_core migrations), openssl, and
// uv, cargo and go on PATH for the Python, Rust and Go workers.
// E2E_LANGUAGES (comma-separated, must include typescript) narrows the
// languages run.
//
//   cd test-apps/e2e/tools && deno test --allow-all spec007-process-e2e-test.ts

import { assert, assertEquals } from "@std/assert";
// @ts-types="@types/pg"
import pg from "pg";

import {
  done,
  enqueue,
  type Language,
  LANGUAGES,
  type LanguageStats,
  statsFor,
} from "./load.ts";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
const ROOT = new URL("../../../", import.meta.url).pathname;
const WORKERS = new URL("../async-worker/", import.meta.url).pathname;
const GATEWAY_CLI =
  `${ROOT}packages/fsm-async-worker-gateway-ts/src/cli/async-operation-worker-gateway.ts`;
const SELECTED = (Deno.env.get("E2E_LANGUAGES") ?? LANGUAGES.join(","))
  .split(",").map((l) => l.trim()) as Language[];

/** pg.Pool's default `max`: the gateway CLI doesn't set one. */
const GATEWAY_POOL_MAX = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A subprocess whose stdout and stderr are kept, for matching log lines. */
class Proc {
  readonly child: Deno.ChildProcess;
  output = "";
  exit: Deno.CommandStatus | undefined;
  readonly status: Promise<Deno.CommandStatus>;

  constructor(
    readonly name: string,
    command: string,
    args: string[],
    options: { cwd: string; env?: Record<string, string> },
  ) {
    this.child = new Deno.Command(command, {
      args,
      cwd: options.cwd,
      env: options.env,
      clearEnv: options.env !== undefined,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    for (const stream of [this.child.stdout, this.child.stderr]) {
      (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) {
          this.output += decoder.decode(chunk, { stream: true });
        }
      })().catch(() => {});
    }
    this.status = this.child.status.then((s) => (this.exit = s));
  }

  get running(): boolean {
    return this.exit === undefined;
  }

  tail(lines = 40): string {
    return this.output.split("\n").slice(-lines).join("\n");
  }

  /** Waits until `pattern` matches the output from offset `from` on. */
  async waitFor(pattern: RegExp, timeoutMs: number, from = 0): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pattern.test(this.output.slice(from))) {
      if (!this.running) {
        throw new Error(
          `${this.name} exited (${this.exit?.code}) before ${pattern}:\n${this.tail()}`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(
          `${this.name}: no ${pattern} within ${timeoutMs}ms:\n${this.tail()}`,
        );
      }
      await sleep(100);
    }
  }

  /** Waits for the process to exit by itself. */
  async exited(timeoutMs: number): Promise<Deno.CommandStatus> {
    const timeout = sleep(timeoutMs).then(() => undefined);
    const status = await Promise.race([this.status, timeout]);
    if (!status) {
      throw new Error(
        `${this.name} still running after ${timeoutMs}ms:\n${this.tail()}`,
      );
    }
    return status;
  }

  /** Signals the process and waits for it, SIGKILL after `graceMs`. */
  async stop(signal: Deno.Signal = "SIGTERM", graceMs = 15_000): Promise<void> {
    if (!this.running) return;
    try {
      this.child.kill(signal);
    } catch { /* already gone */ }
    const timeout = sleep(graceMs).then(() => undefined);
    if (!(await Promise.race([this.status, timeout]))) {
      try {
        this.child.kill("SIGKILL");
      } catch { /* already gone */ }
      await this.status;
    }
  }
}

async function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  const { success, stderr } = await new Deno.Command(command, {
    args,
    cwd,
    stdout: "null",
    stderr: "piped",
  }).output();
  assert(
    success,
    `${command} ${args.join(" ")} failed:\n${new TextDecoder().decode(stderr)}`,
  );
}

/** A CA, a server certificate for localhost, and one token per language. */
async function makeCredentials(dir: string): Promise<void> {
  const ssl = (...args: string[]) => run("openssl", args, dir);
  await ssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
    "-subj",
    "/CN=pgfsm-e2e-ca",
  );
  await ssl(
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "tls.key",
    "-out",
    "tls.csr",
    "-subj",
    "/CN=localhost",
  );
  await Deno.writeTextFile(
    `${dir}/san.ext`,
    "subjectAltName=DNS:localhost,IP:127.0.0.1\n",
  );
  await ssl(
    "x509",
    "-req",
    "-in",
    "tls.csr",
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-days",
    "1",
    "-out",
    "tls.crt",
    "-extfile",
    "san.ext",
  );
  await Deno.mkdir(`${dir}/tokens`);
  for (const language of LANGUAGES) {
    await Deno.writeTextFile(`${dir}/tokens/${language}`, randomToken());
  }
}

function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

/** The gateway's own log line once a worker's Register is accepted. */
const authenticated = (workerId: string, token?: string) =>
  new RegExp(
    `Worker "?${workerId}"? authenticated with token${
      token ? ` "?${token}"?` : ""
    }`,
  );

interface Stack {
  dir: string;
  port: number;
  runId: string;
  db: pg.Pool;
  gatewayApp: string;
  gateway: Proc;
  workers: Map<string, Proc>;
  /** Built Rust and Go worker binaries. */
  binaries: Partial<Record<Language, string>>;
}

function startGateway(stack: Stack): Proc {
  const url = new URL(DATABASE_URL!);
  url.searchParams.set("application_name", stack.gatewayApp);
  return new Proc("gateway", "deno", [
    "run",
    "--allow-all",
    GATEWAY_CLI,
    "--bind",
    `unix:${stack.dir}/gateway.sock`,
    "--sidecar-listen",
    `tcp://127.0.0.1:${stack.port}`,
    "--tls-cert",
    `${stack.dir}/tls.crt`,
    "--tls-key",
    `${stack.dir}/tls.key`,
    "--auth-token-dir",
    `${stack.dir}/tokens`,
    "--db-url",
    url.toString(),
    "--poll-interval-ms",
    "200",
    // A message claimed by a killed gateway comes back after 6 s.
    "--invoke-timeout-ms",
    "5000",
    "--vt-margin-seconds",
    "1",
    "--ensure-queue-on-register",
  ], { cwd: ROOT });
}

/** The environment without anything that points at the database. */
function workerEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(Deno.env.toObject()).filter(([key]) =>
      key !== "DATABASE_URL" && !key.startsWith("PG")
    ),
  );
}

interface WorkerOptions {
  /** Token file; `null` for none. Defaults to the language's own. */
  tokenFile?: string | null;
  /** Defaults to https://localhost:<port>. */
  address?: string;
  extraArgs?: string[];
}

function spawnWorker(
  stack: Stack,
  language: Language,
  workerId: string,
  options: WorkerOptions = {},
): Proc {
  const cwd = `${WORKERS}${language}`;
  const tokenFile = options.tokenFile === undefined
    ? `${stack.dir}/tokens/${language}`
    : options.tokenFile;
  const start = [
    "start",
    "--gateway-address",
    options.address ?? `https://localhost:${stack.port}`,
    "--gateway-ca-file",
    `${stack.dir}/ca.crt`,
    ...(tokenFile ? ["--gateway-token-file", tokenFile] : []),
    "--worker-id",
    workerId,
    "--reconnect-initial-delay-ms",
    "200",
    "--reconnect-max-delay-ms",
    "1000",
    ...(options.extraArgs ?? []),
  ];
  const [command, args] = language === "typescript"
    ? ["deno", ["run", "--allow-all", "run-async-worker.ts", ...start]]
    : language === "python"
    ? ["uv", ["run", "python", "run_async_worker.py", ...start]]
    : [stack.binaries[language]!, start];
  const proc = new Proc(workerId, command, args as string[], {
    cwd,
    env: workerEnv(),
  });
  stack.workers.set(workerId, proc);
  return proc;
}

async function waitDrained(
  stack: Stack,
  runId: string,
  languages: Language[],
  timeoutMs: number,
): Promise<LanguageStats[]> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const all = await Promise.all(
      languages.map((l) => statsFor(stack.db, l, runId)),
    );
    if (all.every(done)) return all;
    if (Date.now() > deadline) {
      throw new Error(
        `run ${runId} not drained after ${timeoutMs}ms: ${JSON.stringify(all)}`,
      );
    }
    await sleep(500);
  }
}

/** Every message of the run succeeded, none lost or left on the queue. */
function assertNoneLost(stats: LanguageStats[]): void {
  for (const s of stats) {
    assertEquals(s.lost, 0, `${s.language}: lost ${JSON.stringify(s)}`);
    assertEquals(
      s.queued,
      0,
      `${s.language}: still queued ${JSON.stringify(s)}`,
    );
    assertEquals(s.succeeded, s.sent, `${s.language}: ${JSON.stringify(s)}`);
  }
}

async function gatewayBackends(stack: Stack): Promise<number> {
  const { rows } = await stack.db.query(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1",
    [stack.gatewayApp],
  );
  return rows[0].n;
}

/** The highest gateway backend count seen while `runId` drains. */
async function maxBackendsWhileDraining(
  stack: Stack,
  runId: string,
  language: Language,
): Promise<{ max: number; stats: LanguageStats }> {
  let max = 0;
  const deadline = Date.now() + 120_000;
  while (true) {
    max = Math.max(max, await gatewayBackends(stack));
    const stats = await statsFor(stack.db, language, runId);
    if (done(stats)) return { max, stats };
    assert(
      Date.now() < deadline,
      `run ${runId} not drained: ${JSON.stringify(stats)}`,
    );
    await sleep(200);
  }
}

Deno.test({
  name: "SPEC-007 process-level E2E: gateway over TLS + token, four workers",
  ignore: !DATABASE_URL,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    assert(
      SELECTED.includes("typescript"),
      "E2E_LANGUAGES must include typescript",
    );
    const runId = `e2e-${crypto.randomUUID().slice(0, 8)}`;
    const dir = await Deno.makeTempDir({ prefix: "pgfsm-spec007-e2e-" });
    const harnessUrl = new URL(DATABASE_URL!);
    harnessUrl.searchParams.set("application_name", `${runId}-harness`);
    const stack: Stack = {
      dir,
      port: freePort(),
      runId,
      db: new pg.Pool({ connectionString: harnessUrl.toString(), max: 2 }),
      gatewayApp: `${runId}-gateway`,
      gateway: undefined as unknown as Proc,
      workers: new Map(),
      binaries: {},
    };
    try {
      await makeCredentials(dir);
      if (SELECTED.includes("rust")) {
        await run("cargo", ["build", "-q"], `${WORKERS}rust`);
        stack.binaries.rust = `${WORKERS}rust/target/debug/run-async-worker`;
      }
      if (SELECTED.includes("go")) {
        stack.binaries.go = `${dir}/worker-go`;
        await run(
          "go",
          ["build", "-o", stack.binaries.go, "."],
          `${WORKERS}go`,
        );
      }
      if (SELECTED.includes("python")) {
        await run("uv", ["sync", "-q"], `${WORKERS}python`);
      }

      stack.gateway = startGateway(stack);
      await stack.gateway.waitFor(/Sidecar worker gateway listening/, 60_000);
      const fleet = SELECTED.map((language) => `${runId}-${language}-1`);
      SELECTED.forEach((language, i) => spawnWorker(stack, language, fleet[i]));

      await t.step(
        "every worker registers with its own token; load is processed once",
        async () => {
          for (const [i, language] of SELECTED.entries()) {
            await stack.gateway.waitFor(
              authenticated(fleet[i], language),
              180_000,
            );
          }
          const id = `${runId}-core`;
          for (const language of SELECTED) {
            await enqueue(stack.db, language, 20, 50, id);
          }
          const stats = await waitDrained(stack, id, SELECTED, 120_000);
          assertNoneLost(stats);
          for (const s of stats) {
            assertEquals(s.failed, 0, `${s.language}: ${JSON.stringify(s)}`);
            assertEquals(
              s.duplicates,
              0,
              `${s.language}: ${JSON.stringify(s)}`,
            );
          }
          const tokens = await Promise.all(
            LANGUAGES.map((l) => Deno.readTextFile(`${dir}/tokens/${l}`)),
          );
          for (const token of tokens) {
            assert(
              !stack.gateway.output.includes(token),
              "a token value is in the gateway's log",
            );
          }
        },
      );

      await t.step(
        "auth: wrong or missing token and plaintext are refused; tokens rotate live",
        async () => {
          const refused = async (workerId: string, options: WorkerOptions) => {
            const worker = spawnWorker(stack, "typescript", workerId, options);
            const status = await worker.exited(60_000);
            assert(
              !status.success,
              `${workerId} exited successfully:\n${worker.tail()}`,
            );
            assert(
              !authenticated(workerId).test(stack.gateway.output),
              `${workerId} registered:\n${stack.gateway.tail()}`,
            );
            return worker;
          };

          await Deno.writeTextFile(`${dir}/wrong-token`, randomToken());
          const wrong = await refused(`${runId}-wrong-token`, {
            tokenFile: `${dir}/wrong-token`,
          });
          assert(/unauthenticated/i.test(wrong.output), wrong.tail());
          const none = await refused(`${runId}-no-token`, { tokenFile: null });
          assert(/unauthenticated/i.test(none.output), none.tail());
          // A cleartext HTTP/2 client against the TLS listener never gets a
          // session; it gives up after its reconnect attempts.
          await refused(`${runId}-plaintext`, {
            address: `http://localhost:${stack.port}`,
            extraArgs: ["--reconnect-max-attempts", "2"],
          });

          // Rotation: a token added to the directory is accepted by the next
          // session, without a gateway restart...
          const next = `${dir}/next-token`;
          await Deno.writeTextFile(next, randomToken());
          await Deno.copyFile(next, `${dir}/tokens/typescript-next`);
          const rotated = spawnWorker(stack, "typescript", `${runId}-rotated`, {
            tokenFile: next,
          });
          await stack.gateway.waitFor(
            authenticated(`${runId}-rotated`, "typescript-next"),
            60_000,
          );
          // ...and once removed, refused for new sessions. Sessions already
          // authenticated with it stay up.
          await Deno.remove(`${dir}/tokens/typescript-next`);
          await refused(`${runId}-removed-token`, { tokenFile: next });
          assert(
            rotated.running,
            `the worker on the removed token exited:\n${rotated.tail()}`,
          );
          await rotated.stop();
          stack.workers.delete(`${runId}-rotated`);
        },
      );

      await t.step(
        "connections: the gateway's backends stay within its pool at 1 and 3 workers",
        async () => {
          const measure = async (label: string) => {
            const id = `${runId}-conn-${label}`;
            await enqueue(stack.db, "typescript", 30, 200, id);
            const { max, stats } = await maxBackendsWhileDraining(
              stack,
              id,
              "typescript",
            );
            assertNoneLost([stats]);
            console.log(
              `  ${label} TypeScript worker(s): ${max} gateway backends, ${stats.perMinute}/min`,
            );
            return max;
          };
          const one = await measure("1");
          assert(one > 0, "no gateway backend seen: is application_name set?");
          for (const k of [2, 3]) {
            const id = `${runId}-typescript-${k}`;
            spawnWorker(stack, "typescript", id);
            await stack.gateway.waitFor(
              authenticated(id, "typescript"),
              60_000,
            );
          }
          const three = await measure("3");
          assert(one <= GATEWAY_POOL_MAX, `${one} backends at 1 worker`);
          assert(three <= GATEWAY_POOL_MAX, `${three} backends at 3 workers`);
        },
      );

      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        await t.step(
          `gateway restart (${signal}) under load loses no messages`,
          async () => {
            const id = `${runId}-restart-${signal.toLowerCase()}`;
            for (const language of SELECTED) {
              await enqueue(stack.db, language, 30, 300, id);
            }
            // Mid-load: some processed, most not.
            const deadline = Date.now() + 60_000;
            while (true) {
              const stats = await Promise.all(
                SELECTED.map((l) => statsFor(stack.db, l, id)),
              );
              if (
                stats.every((s) => s.succeeded >= 3)
              ) {
                break;
              }
              assert(
                Date.now() < deadline,
                `no progress: ${JSON.stringify(stats)}`,
              );
              await sleep(200);
            }
            await stack.gateway.stop(signal, 30_000);
            stack.gateway = startGateway(stack);
            await stack.gateway.waitFor(
              /Sidecar worker gateway listening/,
              60_000,
            );
            for (const [workerId, worker] of stack.workers) {
              if (!worker.running) continue;
              await stack.gateway.waitFor(authenticated(workerId), 60_000);
            }
            for (const workerId of fleet) {
              assert(
                stack.workers.get(workerId)!.running,
                `${workerId} exited`,
              );
            }
            assertNoneLost(await waitDrained(stack, id, SELECTED, 180_000));
          },
        );
      }
    } finally {
      for (const worker of stack.workers.values()) await worker.stop();
      await stack.gateway?.stop();
      await stack.db.end();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
