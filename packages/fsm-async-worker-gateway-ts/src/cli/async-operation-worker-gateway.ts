import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";
import { Pool } from "pg";
import { getLogger } from "@logtape/logtape";
import { CATEGORY, configureLogging, isTerminal } from "@pgfsm/logging";
import type { DBDeps } from "@pgfsm/db";
import { type SidecarListener, startActivityGatewayServer } from "../index.ts";
import { CLI_INVOCATION } from "./gateway-invocation.ts";
import { PACKAGE_VERSION } from "./version.ts";

dotenv.config({ path: ".env" });

const logger = getLogger(["@pgfsm/worker", "async-op-worker-gateway", "cli"]);
// Composition root for this CLI: configures LogTape once, same pattern as
// apps/fsm-core-worker-ts/src/logger.ts's configureWorkerLogger.
await configureLogging({
  levels: { [CATEGORY.worker]: isTerminal ? "debug" : "info" },
});

const args = parseArgs(Deno.args, {
  string: [
    "bind",
    "sidecar-socket",
    "sidecar-listen",
    "tls-cert",
    "tls-key",
    "tls-client-ca",
    "tls-min-version",
    "auth-token-file",
    "auth-token-dir",
    "max-connection-age-ms",
    "keepalive-interval-ms",
    "keepalive-timeout-ms",
    "invoke-timeout-ms",
    "vt-margin-seconds",
    "max-delivery-attempts",
    "db-url",
    "poll-interval-ms",
  ],
  // Several accepted tokens, e.g. old and new during a rotation (#429).
  collect: ["auth-token-file"],
  boolean: [
    "help",
    "version",
    "disable-poll-loop",
    "ensure-queue-on-register",
    "insecure-plaintext",
  ],
  alias: {
    h: "help",
    v: "version",
    b: "bind",
    s: "sidecar-socket",
    t: "invoke-timeout-ms",
    d: "db-url",
  },
});

if (args.version) {
  // Bare, undecorated output (no logger timestamp/category prefix) so
  // `$(async-operation-worker-gateway --version)` stays script-friendly,
  // matching @pgfsm/compiler's --version convention (#258).
  console.log(PACKAGE_VERSION);
  Deno.exit(0);
}

function printHelp(): void {
  logger.info(`
async-operation-worker-gateway — standalone async-op worker: Activity Gateway
+ 30s Postgres poll loop for compiled-language async-operation actors

USAGE
  ${CLI_INVOCATION} [options]

OPTIONS
  -b, --bind <target>              gRPC bind target (default: unix:/tmp/pgfsm-activity-gateway.sock)
  -s, --sidecar-socket <path>      Unix socket path workers connect to (default: /tmp/pgfsm-activity-gateway-workers.sock,
                                   used only when neither this nor --sidecar-listen is given)
  --sidecar-listen <target>        Also (or instead) listen for workers on unix:<path> or tcp://<host>:<port>
  --tls-cert <file>                PEM certificate chain for a tcp:// listener
  --tls-key <file>                 PEM private key for a tcp:// listener
  --tls-client-ca <file>           Mutual TLS: require worker client certificates signed by this CA
  --tls-min-version <1.2|1.3>      Lowest TLS version a tcp:// listener accepts (default: 1.3)
  --insecure-plaintext             Allow a tcp:// listener without TLS (local testing only)
  --auth-token-file <file>         An accepted bearer token for TCP workers; repeat for several (e.g. old
                                   and new during a rotation). Re-read for every new session
  --auth-token-dir <dir>           A directory of accepted tokens, one per file (e.g. a Kubernetes Secret
                                   with one key per language, mounted as a directory); hidden entries skipped
  --max-connection-age-ms <ms>     Drain and disconnect TCP workers after this long, ±10% (default: 600000; 0 disables)
  --keepalive-interval-ms <ms>     HTTP/2 PING interval on TCP worker connections (default: 30000; 0 disables)
  --keepalive-timeout-ms <ms>      Close a TCP connection whose PING goes unanswered this long (default: 10000)
  -t, --invoke-timeout-ms <ms>     Per-invoke timeout for actors without their own timeout_ms (default: 10000)
  --vt-margin-seconds <s>          Claimed messages stay invisible for the invoke timeout plus this (default: 10)
  --max-delivery-attempts <n>      Deliveries before a retriable failure is archived as an actor error (default: 5)
  -d, --db-url <url>               Database connection URL (overrides DATABASE_URL from .env)
  --poll-interval-ms <ms>          Async-op poll loop interval (default: 30000)
  --disable-poll-loop              Don't start the poll loop -- gateway/sidecar only
  --ensure-queue-on-register       Ensure a PGMQ queue exists for every actor a worker registers (default: off)
  -v, --version                    Print @pgfsm/async-worker-gateway's version and exit
  -h, --help                       Show this help message

DESCRIPTION
  Starts the Activity Gateway: a gRPC service (client-facing) backed by a
  sidecar (worker-facing). Compiled-language worker processes connect to the
  sidecar and register the actors they serve, over a Unix socket (single pod)
  or, with --sidecar-listen tcp://..., over TCP with TLS and a bearer token
  (the gateway as its own Deployment, SPEC-007).

  Unless --disable-poll-loop is set, this process also owns its own Postgres
  connection and drives internalAsyncOperation-type async operations for its
  currently-registered actors itself, on a 30-second poll (see
  asyncOpPollLoop.ts / GOAL.md) -- a standalone alternative to
  fsm-async-worker-ts's poll/claim/archive loop, not something that needs it
  running alongside this process.

  With --ensure-queue-on-register, every actor a worker registers also gets
  a PGMQ queue ensured to exist (idempotent). asyncOperationType is always
  shortened to its first character; when asyncOperationType is exactly
  "internalAsyncOperation", asyncOperationVersion is dropped and
  asyncOperationLanguage is also shortened to its first character:
    asyncOperationType "internalAsyncOperation":  <parentFsmName>_<parentFsmVersion>_<asyncOperationType[0]>_<asyncOperationName>_<asyncOperationLanguage[0]>
    otherwise:                                    <parentFsmName>_<parentFsmVersion>_<asyncOperationType[0]>_<asyncOperationName>_<asyncOperationVersion>_<asyncOperationLanguage>
  PGMQ enforces a 48-character limit on that name -- long identities can
  still exceed it (more likely on the non-"internalAsyncOperation" path) and will fail
  this step (registration itself still succeeds; only the queue-ensure call
  fails, logged as an error).
`);
}

if (args.help) {
  printHelp();
  Deno.exit(0);
}

const bindTarget = args.bind ?? "unix:/tmp/pgfsm-activity-gateway.sock";

/** An integer flag ≥ `min`, or undefined when not given; exits if invalid. */
function integerFlag(name: string, min = 0): number | undefined {
  const raw = args[name as keyof typeof args] as string | undefined;
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    logger.error("--{name} must be an integer ≥ {min}, got: {value}", {
      name,
      min,
      value: raw,
    });
    Deno.exit(1);
  }
  return value;
}

const defaultInvokeTimeoutMs = integerFlag("invoke-timeout-ms", 1);
const maxConnectionAgeMs = integerFlag("max-connection-age-ms");
const keepaliveIntervalMs = integerFlag("keepalive-interval-ms");
const keepaliveTimeoutMs = integerFlag("keepalive-timeout-ms", 1);
const vtMarginSeconds = integerFlag("vt-margin-seconds");
const maxDeliveryAttempts = integerFlag("max-delivery-attempts", 1);

// With neither --sidecar-socket nor --sidecar-listen, serve today's default
// socket, so a plain `async-operation-worker-gateway` behaves as before.
const sidecarListenArg = args["sidecar-listen"];
const sidecarSocketPath = args["sidecar-socket"] ??
  (sidecarListenArg ? undefined : "/tmp/pgfsm-activity-gateway-workers.sock");

function parseSidecarListen(target: string): SidecarListener {
  if (target.startsWith("unix:")) {
    const path = target.slice("unix:".length);
    if (path) return { kind: "unix", path };
  }
  const tcp = /^tcp:\/\/(.+):(\d+)$/.exec(target);
  if (tcp) {
    const host = tcp[1].replace(/^\[(.*)\]$/, "$1");
    const port = Number(tcp[2]);
    const certFile = args["tls-cert"];
    const keyFile = args["tls-key"];
    if (!!certFile !== !!keyFile) {
      logger.error("--tls-cert and --tls-key must be given together");
      Deno.exit(1);
    }
    if (certFile && keyFile) {
      const minVersionArg = args["tls-min-version"] ?? "1.3";
      if (minVersionArg !== "1.2" && minVersionArg !== "1.3") {
        logger.error("--tls-min-version must be 1.2 or 1.3, got: {value}", {
          value: minVersionArg,
        });
        Deno.exit(1);
      }
      return {
        kind: "tcp",
        host,
        port,
        tls: {
          certFile,
          keyFile,
          clientCaFile: args["tls-client-ca"],
          minVersion: minVersionArg === "1.2" ? "TLSv1.2" : "TLSv1.3",
        },
      };
    }
    if (args["tls-client-ca"]) {
      logger.error("--tls-client-ca needs --tls-cert and --tls-key");
      Deno.exit(1);
    }
    if (!args["insecure-plaintext"]) {
      logger.error(
        "A tcp:// sidecar listener needs --tls-cert and --tls-key, or --insecure-plaintext for local testing",
      );
      Deno.exit(1);
    }
    logger.warn(
      "Sidecar listener {target} is plaintext (--insecure-plaintext): use it for local testing only",
      { target },
    );
    return { kind: "tcp", host, port };
  }
  logger.error(
    "--sidecar-listen must be unix:<path> or tcp://<host>:<port>, got: {target}",
    { target },
  );
  Deno.exit(1);
}

const sidecarListeners = sidecarListenArg
  ? [parseSidecarListen(sidecarListenArg)]
  : [];
if (
  sidecarListeners.some((l) => l.kind === "tcp") &&
  args["auth-token-file"].length === 0 && !args["auth-token-dir"] &&
  !args["tls-client-ca"]
) {
  logger.warn(
    "The TCP sidecar listener has no --auth-token-file, --auth-token-dir or --tls-client-ca: any client that reaches it can register as a worker",
  );
}

const pollLoopEnabled = !args["disable-poll-loop"];
const ensureQueueOnRegisterEnabled = !!args["ensure-queue-on-register"];
const needsDb = pollLoopEnabled || ensureQueueOnRegisterEnabled;

let dbPool: Pool | undefined;
let asyncOpPollLoopOption:
  | {
    deps: DBDeps;
    intervalMs?: number;
    invokeTimeoutMs?: number;
    vtMarginSeconds?: number;
    maxDeliveryAttempts?: number;
  }
  | undefined;
let ensureQueueOnRegisterOption: { deps: DBDeps } | undefined;

if (needsDb) {
  const resolvedDbUrl = args["db-url"] ?? Deno.env.get("DATABASE_URL") ?? "";
  if (!resolvedDbUrl) {
    logger.error(
      "DATABASE_URL is required for the poll loop and/or --ensure-queue-on-register (set in .env or pass --db-url), or pass --disable-poll-loop (and omit --ensure-queue-on-register) to run the gateway/sidecar only",
    );
    Deno.exit(1);
  }
  dbPool = new Pool({ connectionString: resolvedDbUrl });
  const deps: DBDeps = { db: dbPool, useSupabase: false };

  if (pollLoopEnabled) {
    const pollIntervalArg = args["poll-interval-ms"];
    const pollIntervalMs = pollIntervalArg
      ? Number(pollIntervalArg)
      : undefined;
    if (pollIntervalArg && !Number.isInteger(pollIntervalMs)) {
      logger.error(
        "--poll-interval-ms must be a positive integer, got: {value}",
        { value: pollIntervalArg },
      );
      Deno.exit(1);
    }
    asyncOpPollLoopOption = {
      deps,
      intervalMs: pollIntervalMs,
      invokeTimeoutMs: defaultInvokeTimeoutMs,
      vtMarginSeconds,
      maxDeliveryAttempts,
    };
  }

  if (ensureQueueOnRegisterEnabled) {
    ensureQueueOnRegisterOption = { deps };
  }
}

const controller = new AbortController();
let shutdownRequested = false;

const onSignal = () => {
  if (shutdownRequested) {
    logger.info("Force exit.");
    Deno.exit(0);
  }
  shutdownRequested = true;
  logger.info(
    "Shutdown requested — stopping activity gateway gracefully. Ctrl+C again to force exit...",
  );
  controller.abort();
};

Deno.addSignalListener("SIGINT", onSignal);
Deno.addSignalListener("SIGTERM", onSignal);

try {
  logger.info(
    "Starting activity gateway: bind={bind}, sidecar-socket={socket}, sidecar-listen={listen}, pollLoop={pollLoop}, ensureQueueOnRegister={ensureQueueOnRegister}",
    {
      bind: bindTarget,
      socket: sidecarSocketPath ?? "(none)",
      listen: sidecarListenArg ?? "(none)",
      pollLoop: pollLoopEnabled,
      ensureQueueOnRegister: ensureQueueOnRegisterEnabled,
    },
  );
  await startActivityGatewayServer({
    bindTarget,
    sidecarSocketPath,
    sidecarListeners,
    sidecarAuthTokenFiles: args["auth-token-file"],
    sidecarAuthTokenDir: args["auth-token-dir"],
    maxConnectionAgeMs,
    keepaliveIntervalMs,
    keepaliveTimeoutMs,
    defaultInvokeTimeoutMs,
    signal: controller.signal,
    asyncOpPollLoop: asyncOpPollLoopOption,
    ensureQueueOnRegister: ensureQueueOnRegisterOption,
  });
  logger.info("Activity gateway stopped.");
} catch (err) {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  logger.error("Activity gateway failed: {error}", { error: msg });
  Deno.exit(1);
} finally {
  if (dbPool) {
    await dbPool.end();
  }
}
