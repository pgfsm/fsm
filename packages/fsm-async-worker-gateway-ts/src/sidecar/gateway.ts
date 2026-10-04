// Sidecar gateway: accepts one worker-initiated bidi-streaming Session call
// per worker process, tracks which actors each worker has registered, and
// routes invocations to the right worker's stream. Bound via node:http2 +
// connectNodeAdapter, the same mechanism gatewayServer.ts uses for the
// client-facing ActivityGateway leg, on one or more listeners: a Unix socket
// (the default, and the single-pod topology) and/or TCP, with TLS and a bearer
// token, for the gateway-as-a-Deployment topology (SPEC-007).
//
// Replaces the hand-rolled length-prefixed-JSON envelope this class used to
// speak (the former sidecar/protocol.ts's readFrame/writeFrame/makeEnvelope,
// deleted along with the compiler's legacy worker SDKs in #356) with the
// generated pgfsm.sidecargateway.v1.SidecarGatewayService stub, from
// packages/fsm-proto-codegen/proto/fsm-async-worker-gateway-ts/pgfsm/sidecargateway/v1/sidecar_gateway.proto
// — see #100. Imported as @pgfsm/proto-codegen (a Deno workspace-linked package, not published —
// see #103), not a relative path into fsm-proto-codegen/gen/. The
// connection/registration/pending-invoke bookkeeping is otherwise unchanged
// from the protocol.ts-based version, which was itself ported from the
// polygot-lang-ipc-worker prototype's server/src/sidecar/gateway.ts; routing
// keys are `parentFsmName@parentFsmVersion@asyncOperationType@asyncOperationName@asyncOperationVersion@asyncOperationLanguage`
// (see this file's own `actorKey()`).
//
// This class never opens a database connection — it only relays messages
// between the gRPC-facing AsyncOperationWorkerGateway and worker processes,
// keeping the zero-DB-connections property SPEC-001 requires of the
// polyglot side.

import { getLogger } from "@logtape/logtape";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import {
  Code,
  ConnectError,
  type ConnectRouter,
  type HandlerContext,
  type ServiceImpl,
} from "@connectrpc/connect";
import * as http2 from "node:http2";
import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { SidecarGatewayService } from "@pgfsm/proto-codegen/sidecargateway/v1/connect";
import {
  Invoke,
  type Register,
  RegisterAck,
  type SessionRequest,
  SessionResponse,
} from "@pgfsm/proto-codegen/sidecargateway/v1/pb";
import {
  closeHttp2Server,
  DEFAULT_SHUTDOWN_GRACE_MS,
  isNotFoundError,
  trackHttp2Sessions,
} from "../util.ts";

const logger = getLogger([
  "@pgfsm/worker",
  "async-op-worker-gateway",
  "sidecar",
]);

// `deno check` fails to merge these generated classes' sibling .d.ts type
// declarations with their .js value bindings when imported by name (the same
// gap gatewayClient.ts/gatewayServer.ts document for Connect's `Client<T>`
// utility type) — using the constructor's instance type instead sidesteps it
// and still tracks the generated shape exactly (no hand-duplicated fields).
type RegisterMessage = InstanceType<typeof Register>;
type RegisterAckMessage = InstanceType<typeof RegisterAck>;
type SessionRequestMessage = InstanceType<typeof SessionRequest>;
type SessionResponseMessage = InstanceType<typeof SessionResponse>;

/**
 * Plain structural mirror of the generated `RegisteredActor` proto message
 * (see sidecar_gateway.proto), hand-written rather than derived via
 * `InstanceType<typeof RegisteredActor>` — unlike this file's other
 * `*Message` aliases, this one is re-exported and consumed by other files
 * (gatewayServer.ts, asyncOpPollLoop.ts's `AsyncOperationWorkerIdentity`), and the
 * derived alias silently widened to `AnyMessage` once it crossed a file
 * boundary under `deno check` (caught by `AsyncOperationWorkerIdentity` assignment
 * errors downstream, not by this file's own check). The actual values
 * flowing through these fields are still real generated `RegisteredActor`
 * instances off the wire — structurally compatible with this interface, so
 * no conversion is needed, only a type that survives re-export.
 */
export interface RegisteredActor {
  parentFsmName: string;
  parentFsmVersion: string;
  asyncOperationType: string;
  asyncOperationName: string;
  asyncOperationVersion: string;
  asyncOperationLanguage: string;
  timeoutMs: number;
  description: string;
  /** Invokes of this actor the worker runs at once; 0 (older SDKs) means 1. */
  maxConcurrency: number;
}

export function actorKey(
  parentFsmName: string,
  parentFsmVersion: string,
  asyncOperationType: string,
  asyncOperationName: string,
  asyncOperationVersion: string,
  asyncOperationLanguage: string,
): string {
  return `${parentFsmName}@${parentFsmVersion}@${asyncOperationType}@${asyncOperationName}@${asyncOperationVersion}@${asyncOperationLanguage}`;
}

function keyOf(
  actor: Omit<RegisteredActor, "timeoutMs" | "description" | "maxConcurrency">,
): string {
  return actorKey(
    actor.parentFsmName,
    actor.parentFsmVersion,
    actor.asyncOperationType,
    actor.asyncOperationName,
    actor.asyncOperationVersion,
    actor.asyncOperationLanguage,
  );
}

/** A worker's declared concurrency for one actor: 0 (unset) means 1. */
function concurrencyOf(maxConcurrency: number | undefined): number {
  return maxConcurrency && maxConcurrency > 0 ? maxConcurrency : 1;
}

function toInputJson(input: unknown): string {
  return JSON.stringify(input ?? null);
}

function parseOutputJson(json: string): unknown {
  if (!json.trim()) {
    return null;
  }
  return JSON.parse(json);
}

export interface ActivityInvokeInput {
  parentFsmName: string;
  parentFsmVersion: string;
  asyncOperationType: string;
  asyncOperationName: string;
  asyncOperationVersion: string;
  asyncOperationLanguage: string;
  input: unknown;
  instanceId: string;
  correlationId: string;
}

export interface ActivityInvokeResult {
  output: unknown;
}

/**
 * An invoke that didn't produce a result. `retriable` marks failures that say
 * nothing about the actor itself (no worker, the worker went away, a timeout,
 * a draining worker): the poll loop leaves those messages on the queue to be
 * delivered again instead of reporting them to the FSM as actor errors (#396).
 */
export class ActivityInvokeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retriable = false,
  ) {
    super(message);
    this.name = "ActivityInvokeError";
  }
}

/**
 * Minimal async push queue backing each worker's outbound SessionResponse
 * stream. `invoke()` (called from arbitrary places, e.g. the poll loop) and
 * `registerWorker()` push server-initiated messages (register_ack, invoke)
 * onto a worker's queue; `handleSession`'s `for await` loop is the only
 * reader, draining it into that worker's actual HTTP/2 stream. No
 * backpressure beyond an unbounded in-memory array — acceptable here since
 * the sidecar only ever queues a handful of in-flight invokes per worker.
 */
class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private readonly waiting: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const next = this.waiting.shift();
    if (next) {
      next({ value: item, done: false });
      return;
    }
    this.buffered.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.waiting.splice(0)) {
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffered.length > 0) {
          return Promise.resolve({
            value: this.buffered.shift()!,
            done: false,
          });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.waiting.push(resolve));
      },
      // Connect's transport machinery expects the full async-iterator
      // protocol on any iterable it wraps for abort handling (native async
      // generators get `throw`/`return` for free; this hand-rolled queue
      // needs them spelled out) — see the identically-shaped queue in
      // @pgfsm/async-worker-sdk's actorWorker.ts, where omitting these fails client calls outright
      // with "AsyncIterable does not implement throw".
      return: (value?: T): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({ value: value as T, done: true });
      },
      throw: (error?: unknown): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.reject(error);
      },
    };
  }
}

interface PendingInvoke {
  resolve: (value: ActivityInvokeResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  key: string;
}

interface WorkerState {
  workerId: string;
  language: string;
  outbox: AsyncQueue<SessionResponseMessage>;
  actors: Set<string>;
  /** Declared max_concurrency per actor key (always ≥ 1). */
  maxConcurrencyByKey: Map<string, number>;
  pendingByInvokeId: Map<string, PendingInvoke>;
  alive: boolean;
  /**
   * Past its max connection age: gets no new invokes and counts for no
   * capacity, and is closed once its in-flight invokes finish (SPEC-007).
   */
  draining: boolean;
  /** Max-connection-age and drain timers, cleared on unregister. */
  timers: Set<ReturnType<typeof setTimeout>>;
  /** The HTTP/2 session its stream arrived on, closed (GOAWAY) after a drain. */
  http2Session?: http2.ServerHttp2Session;
}

// Every worker currently serving one actor key. Several workers (replicas of
// the same language worker) may register the same actor; invoke() spreads
// calls across them and unregistering one leaves the others routable (#391).
interface ActorRoute {
  workerIds: Set<string>;
  // Identity of the most recent registration — every worker registering this
  // key sends the same identity fields, so any one of them serves as the
  // poll loop's claim input.
  meta: RegisteredActor;
  // Rotating start offset so ties on free slots don't always land on the
  // same worker.
  cursor: number;
}

/** One place workers can connect: a Unix socket or a TCP port. */
export type SidecarListener =
  | { kind: "unix"; path: string }
  | {
    kind: "tcp";
    host: string;
    port: number;
    /**
     * PEM certificate chain and key files. Omitted means plaintext, which
     * the CLI only allows with --insecure-plaintext (local testing).
     */
    tls?: SidecarTls;
  };

/** TLS settings of a TCP sidecar listener (SPEC-007 §1). */
export interface SidecarTls {
  /** PEM certificate chain the gateway presents. */
  certFile: string;
  /** PEM private key for `certFile`. */
  keyFile: string;
  /**
   * PEM CA bundle for mutual TLS: when set, every worker must present a
   * client certificate signed by it, or the TLS handshake fails before any
   * gRPC call (no shared secret needed). Unset: server-side TLS only.
   */
  clientCaFile?: string;
  /** Lowest TLS version accepted. Default TLSv1.3. */
  minVersion?: "TLSv1.2" | "TLSv1.3";
}

/** Per-actor routing state of one gateway replica (SPEC-007 §4). */
export interface ActorRoutingSnapshot {
  actorKey: string;
  identity: Omit<
    RegisteredActor,
    "timeoutMs" | "description" | "maxConcurrency"
  >;
  /** Connected workers serving this actor, draining ones included. */
  liveWorkers: number;
  /** Σ declared max_concurrency over those workers. */
  maxConcurrency: number;
  /** Invokes of this actor currently waiting on a worker. */
  inFlight: number;
}

/** An actor the poll loop can claim for, with how much room it has. */
export interface ClaimableActor {
  identity: RegisteredActor;
  /** Σ (max_concurrency − in-flight) over non-draining workers, ≥ 0. */
  freeSlots: number;
}

export interface SidecarGatewayOptions {
  /** Shorthand for one Unix-socket listener (today's default topology). */
  socketPath?: string;
  /** Listeners to serve; added to `socketPath`'s, if both are given. */
  listeners?: SidecarListener[];
  /**
   * File holding a bearer token TCP workers may send
   * (`authorization: Bearer <token>`). Shorthand for a one-element
   * `authTokenFiles`. Unix-socket sessions aren't checked.
   */
  authTokenFile?: string;
  /**
   * Files each holding one accepted bearer token (#429). A TCP worker must
   * send one of them. Re-read for every new session, so tokens can be added
   * and removed without a restart: during a rotation, list both the old and
   * the new token.
   */
  authTokenFiles?: string[];
  /**
   * A directory whose every file is one accepted token, named after the file
   * (#429): fits a Kubernetes Secret with one key per language or service,
   * mounted as a directory. Hidden entries (a Secret volume's `..data` and
   * `..<timestamp>`) are skipped. Re-read for every new session, like
   * `authTokenFiles`, and combined with them.
   */
  authTokenDir?: string;
  /**
   * TCP workers are drained and disconnected after this long (±10 %
   * jitter), so they reconnect and spread across gateway replicas. 0
   * disables. Default 10 min.
   */
  maxConnectionAgeMs?: number;
  /**
   * How long a draining worker gets to finish its in-flight invokes before
   * it's disconnected anyway (default 30 s).
   */
  connectionDrainGraceMs?: number;
  /**
   * HTTP/2 PING interval on TCP connections; a connection whose PING goes
   * unanswered for `keepaliveTimeoutMs` is destroyed, so a half-open
   * connection doesn't go unnoticed. 0 disables. Defaults 30 s / 10 s.
   */
  keepaliveIntervalMs?: number;
  keepaliveTimeoutMs?: number;
  /**
   * Called once per actor, synchronously, whenever a worker registers it
   * (including on re-registration). Fire-and-forget by design — registration
   * itself never waits on this callback's own async work (e.g. an
   * ensureQueueOnRegister DB call); callers that need to react to failures
   * should handle them inside the callback itself.
   */
  onActorRegistered?: (actor: RegisteredActor) => void;
  /**
   * How long `stop()` lets open worker connections finish before destroying
   * them (default 5 s).
   */
  shutdownGraceMs?: number;
}

export const DEFAULT_MAX_CONNECTION_AGE_MS = 10 * 60_000;
export const DEFAULT_CONNECTION_DRAIN_GRACE_MS = 30_000;
export const DEFAULT_KEEPALIVE_INTERVAL_MS = 30_000;
export const DEFAULT_KEEPALIVE_TIMEOUT_MS = 10_000;
const DRAIN_POLL_MS = 100;

/** How a session's listener treats it: auth and max age only apply to TCP. */
interface ListenerPolicy {
  kind: "unix" | "tcp";
}

const UNIX_POLICY: ListenerPolicy = { kind: "unix" };

interface RunningListener {
  listener: SidecarListener;
  server: http2.Http2Server | http2.Http2SecureServer;
  sessions: Set<http2.ServerHttp2Session>;
  keepalives: Set<ReturnType<typeof setInterval>>;
}

/** One accepted bearer token, and the name it's logged under (never the value). */
interface AcceptedToken {
  name: string;
  value: string;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Constant-time comparison of two header values. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    // Still spend the comparison, so the length doesn't leak through timing.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export class SidecarGateway {
  private readonly listeners: SidecarListener[];
  private readonly authTokenFiles: string[];
  private readonly authTokenDir?: string;
  private readonly maxConnectionAgeMs: number;
  private readonly connectionDrainGraceMs: number;
  private readonly keepaliveIntervalMs: number;
  private readonly keepaliveTimeoutMs: number;
  private readonly onActorRegistered?: (actor: RegisteredActor) => void;
  private readonly shutdownGraceMs: number;
  private running: RunningListener[] = [];
  private readonly workers = new Map<string, WorkerState>();
  private readonly actorRoutes = new Map<string, ActorRoute>();
  /** The HTTP/2 session a Session call arrived on, for its handler. */
  private readonly currentHttp2Session = new AsyncLocalStorage<
    http2.ServerHttp2Session
  >();

  constructor(options: SidecarGatewayOptions) {
    this.listeners = [
      ...(options.socketPath
        ? [{ kind: "unix", path: options.socketPath } as const]
        : []),
      ...(options.listeners ?? []),
    ];
    this.authTokenFiles = [
      ...(options.authTokenFile ? [options.authTokenFile] : []),
      ...(options.authTokenFiles ?? []),
    ];
    this.authTokenDir = options.authTokenDir;
    this.maxConnectionAgeMs = options.maxConnectionAgeMs ??
      DEFAULT_MAX_CONNECTION_AGE_MS;
    this.connectionDrainGraceMs = options.connectionDrainGraceMs ??
      DEFAULT_CONNECTION_DRAIN_GRACE_MS;
    this.keepaliveIntervalMs = options.keepaliveIntervalMs ??
      DEFAULT_KEEPALIVE_INTERVAL_MS;
    this.keepaliveTimeoutMs = options.keepaliveTimeoutMs ??
      DEFAULT_KEEPALIVE_TIMEOUT_MS;
    this.onActorRegistered = options.onActorRegistered;
    this.shutdownGraceMs = options.shutdownGraceMs ??
      DEFAULT_SHUTDOWN_GRACE_MS;
  }

  async start(): Promise<void> {
    if (this.listeners.length === 0) {
      throw new Error(
        "SidecarGateway needs at least one listener (socketPath or listeners)",
      );
    }
    if (
      (this.authTokenFiles.length > 0 || this.authTokenDir) &&
      this.acceptedTokens().length === 0
    ) {
      logger.warn(
        "Sidecar auth is configured but no token is readable yet: every TCP worker is refused until one is",
      );
    }
    for (const listener of this.listeners) {
      this.running.push(await this.listen(listener));
    }
  }

  /**
   * Where each listener ended up, in `listeners` order — e.g. the real port
   * of a TCP listener started on port 0.
   */
  addresses(): SidecarListener[] {
    return this.running.map(({ listener, server }) => {
      if (listener.kind === "unix") return listener;
      const address = server.address();
      const port = typeof address === "object" && address
        ? address.port
        : listener.port;
      return { ...listener, port };
    });
  }

  private async listen(listener: SidecarListener): Promise<RunningListener> {
    const policy: ListenerPolicy = { kind: listener.kind };
    const routes = (router: ConnectRouter): void => {
      router.service(
        SidecarGatewayService,
        {
          session: (
            requests: AsyncIterable<SessionRequestMessage>,
            context: HandlerContext,
          ) => this.handleSession(requests, context, policy),
        } as unknown as Partial<ServiceImpl<typeof SidecarGatewayService>>,
      );
    };
    const adapter = connectNodeAdapter({ routes });
    // Carries the request's HTTP/2 session into the Session handler, so a
    // drained worker's connection can be closed (GOAWAY), not just its stream.
    const handler = (
      req: http2.Http2ServerRequest,
      res: http2.Http2ServerResponse,
    ) =>
      this.currentHttp2Session.run(
        req.stream.session as http2.ServerHttp2Session,
        () => adapter(req, res),
      );

    let server: http2.Http2Server | http2.Http2SecureServer;
    if (listener.kind === "tcp" && listener.tls) {
      const { certFile, keyFile, clientCaFile, minVersion } = listener.tls;
      server = http2.createSecureServer(
        {
          cert: Deno.readTextFileSync(certFile),
          key: Deno.readTextFileSync(keyFile),
          allowHTTP1: false,
          minVersion: minVersion ?? "TLSv1.3",
          // Mutual TLS: refuse the handshake unless the worker presents a
          // certificate signed by the client CA.
          ...(clientCaFile
            ? {
              ca: Deno.readTextFileSync(clientCaFile),
              requestCert: true,
              rejectUnauthorized: true,
            }
            : {}),
        },
        handler,
      );
    } else {
      server = http2.createServer(handler);
    }
    const sessions = trackHttp2Sessions(server as http2.Http2Server);
    const keepalives = new Set<ReturnType<typeof setInterval>>();
    if (listener.kind === "tcp" && this.keepaliveIntervalMs > 0) {
      server.on("session", (session) => this.keepAlive(session, keepalives));
    }

    if (listener.kind === "unix") {
      this.cleanupSocket(listener.path);
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      if (listener.kind === "unix") {
        server.listen(listener.path, onListening);
      } else {
        server.listen(listener.port, listener.host, onListening);
      }
    });
    return { listener, server, sessions, keepalives };
  }

  /**
   * PINGs a TCP connection every keepaliveIntervalMs and destroys it if a
   * PING goes unanswered for keepaliveTimeoutMs — the stream then errors, the
   * worker is unregistered and its in-flight invokes fail as retriable.
   */
  private keepAlive(
    session: http2.ServerHttp2Session,
    keepalives: Set<ReturnType<typeof setInterval>>,
  ): void {
    let awaitingAck: ReturnType<typeof setTimeout> | undefined;
    const interval = setInterval(() => {
      if (awaitingAck || session.destroyed || session.closed) return;
      awaitingAck = setTimeout(() => {
        logger.warn("Sidecar connection missed a keepalive PING; closing it");
        session.destroy(new Error("keepalive timeout"));
      }, this.keepaliveTimeoutMs);
      const sent = session.ping((error) => {
        clearTimeout(awaitingAck);
        awaitingAck = undefined;
        if (error && !session.destroyed) session.destroy(error);
      });
      if (!sent) {
        clearTimeout(awaitingAck);
        awaitingAck = undefined;
      }
    }, this.keepaliveIntervalMs);
    keepalives.add(interval);
    session.once("close", () => {
      clearInterval(interval);
      clearTimeout(awaitingAck);
      keepalives.delete(interval);
    });
  }

  /**
   * Unregisters every worker — failing their in-flight invokes as
   * WORKER_DISCONNECTED (retriable) rather than leaving callers to wait out
   * the invoke timeout — ends each Session stream so workers see EOF and go
   * reconnect, then closes every listener (#397).
   */
  async stop(): Promise<void> {
    for (const worker of [...this.workers.values()]) {
      this.unregisterWorker(worker);
    }
    this.actorRoutes.clear();

    const running = this.running;
    this.running = [];
    await Promise.all(
      running.map(async ({ listener, server, sessions, keepalives }) => {
        for (const interval of keepalives) clearInterval(interval);
        await closeHttp2Server(
          server as http2.Http2Server,
          sessions,
          this.shutdownGraceMs,
        );
        if (listener.kind === "unix") this.cleanupSocket(listener.path);
      }),
    );
  }

  listRegisteredActors(): string[] {
    return Array.from(this.actorRoutes.keys()).sort();
  }

  /**
   * Full identity of every currently-registered actor (not just the routing
   * key) — the shape the async-op poll loop sends to
   * `claimPendingAsyncOperationEventsForWorkers` (minus a `handler`, since these are
   * remote processes reached over the socket, not in-process functions).
   */
  listRegisteredActorIdentities(): RegisteredActor[] {
    return Array.from(this.actorRoutes.values()).map((route) => route.meta);
  }

  /**
   * Every registered actor with its free slots: what the poll loop may claim
   * right now without overloading this replica's workers (SPEC-007 §5).
   */
  listClaimableActors(): ClaimableActor[] {
    return Array.from(this.actorRoutes.entries()).map(([key, route]) => {
      let freeSlots = 0;
      for (const worker of this.routeWorkers(route)) {
        if (worker.draining) continue;
        freeSlots += Math.max(0, this.freeSlotsOf(worker, key));
      }
      return { identity: route.meta, freeSlots };
    });
  }

  /**
   * Per-actor routing snapshot of this replica: live workers, Σ
   * max_concurrency, and in-flight invokes (SPEC-007 §4). How it's exposed
   * or aggregated across replicas is up to the caller (SPEC-008).
   */
  routingSnapshot(): ActorRoutingSnapshot[] {
    return Array.from(this.actorRoutes.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, route]) => {
        let maxConcurrency = 0;
        let inFlight = 0;
        const workers = this.routeWorkers(route);
        for (const worker of workers) {
          maxConcurrency += worker.maxConcurrencyByKey.get(key) ?? 1;
          inFlight += this.inFlightOf(worker, key);
        }
        const {
          timeoutMs: _t,
          description: _d,
          maxConcurrency: _m,
          ...identity
        } = route.meta;
        return {
          actorKey: key,
          identity,
          liveWorkers: workers.length,
          maxConcurrency,
          inFlight,
        };
      });
  }

  async invoke(
    request: ActivityInvokeInput,
    timeoutMs: number,
  ): Promise<ActivityInvokeResult> {
    const key = actorKey(
      request.parentFsmName,
      request.parentFsmVersion,
      request.asyncOperationType,
      request.asyncOperationName,
      request.asyncOperationVersion,
      request.asyncOperationLanguage,
    );
    const route = this.actorRoutes.get(key);
    if (!route) {
      // Retriable: the only worker for this actor may just be reconnecting
      // between the poll loop's claim and this dispatch (#396).
      throw new ActivityInvokeError(
        `no worker registered for actor: ${key}`,
        "ACTOR_NOT_FOUND",
        true,
      );
    }

    const worker = this.pickWorker(route, key);
    if (!worker) {
      throw new ActivityInvokeError(
        `worker unavailable for actor: ${key}`,
        "WORKER_UNAVAILABLE",
        true,
      );
    }

    const invokeId = crypto.randomUUID();

    return await new Promise<ActivityInvokeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.pendingByInvokeId.delete(invokeId);
        reject(
          new ActivityInvokeError(
            `actor invocation timed out after ${timeoutMs}ms`,
            "TIMEOUT",
            true,
          ),
        );
      }, timeoutMs);

      worker.pendingByInvokeId.set(invokeId, {
        resolve,
        reject,
        timer,
        key,
      });

      worker.outbox.push(
        new SessionResponse({
          payload: {
            case: "invoke",
            value: new Invoke({
              invokeId,
              parentFsmName: request.parentFsmName,
              parentFsmVersion: request.parentFsmVersion,
              asyncOperationType: request.asyncOperationType,
              asyncOperationName: request.asyncOperationName,
              asyncOperationVersion: request.asyncOperationVersion,
              asyncOperationLanguage: request.asyncOperationLanguage,
              inputJson: toInputJson(request.input),
              instanceId: request.instanceId,
              correlationId: request.correlationId,
              timeoutMs,
              deadlineUnixMs: BigInt(Date.now() + timeoutMs),
            }),
          },
        }),
      );
    });
  }

  private routeWorkers(route: ActorRoute): WorkerState[] {
    const workers: WorkerState[] = [];
    for (const workerId of route.workerIds) {
      const worker = this.workers.get(workerId);
      if (worker?.alive) workers.push(worker);
    }
    return workers;
  }

  private inFlightOf(worker: WorkerState, key: string): number {
    let count = 0;
    for (const pending of worker.pendingByInvokeId.values()) {
      if (pending.key === key) count++;
    }
    return count;
  }

  private freeSlotsOf(worker: WorkerState, key: string): number {
    return (worker.maxConcurrencyByKey.get(key) ?? 1) -
      this.inFlightOf(worker, key);
  }

  /**
   * Picks the alive, non-draining worker with the most free slots for this
   * actor (its max_concurrency minus its in-flight invokes of it), scanning
   * from a rotating offset so equally-free workers take turns. A worker with
   * no free slot is still picked if nothing better exists (e.g. a direct
   * Invoke() RPC); the poll loop never claims more than the free slots.
   */
  private pickWorker(route: ActorRoute, key: string): WorkerState | undefined {
    const candidates = this.routeWorkers(route).filter((w) => !w.draining);
    if (candidates.length === 0) {
      return undefined;
    }

    const start = route.cursor++ % candidates.length;
    let best = candidates[start];
    let bestFree = this.freeSlotsOf(best, key);
    for (let i = 1; i < candidates.length; i++) {
      const candidate = candidates[(start + i) % candidates.length];
      const free = this.freeSlotsOf(candidate, key);
      if (free > bestFree) {
        best = candidate;
        bestFree = free;
      }
    }
    return best;
  }

  /**
   * Every token a TCP worker may present right now, read from
   * `authTokenFiles` and `authTokenDir` for each new session, so rotations
   * apply without a restart. An unreadable or empty source is logged and
   * contributes nothing; if none is left, every TCP session is refused.
   */
  private acceptedTokens(): AcceptedToken[] {
    const tokens: AcceptedToken[] = [];
    const add = (name: string, path: string) => {
      let value: string;
      try {
        value = Deno.readTextFileSync(path).trim();
      } catch (error) {
        logger.error("Can't read the sidecar auth token file {file}: {error}", {
          file: path,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (value) tokens.push({ name, value });
      else {logger.warn("Ignoring empty sidecar auth token file {file}", {
          file: path,
        });}
    };
    for (const file of this.authTokenFiles) add(baseName(file), file);
    if (this.authTokenDir) {
      try {
        for (const entry of Deno.readDirSync(this.authTokenDir)) {
          // A Kubernetes Secret volume holds `..data` and `..<timestamp>`
          // next to one symlink per key: hidden names aren't tokens.
          if (entry.name.startsWith(".")) continue;
          const path = `${this.authTokenDir}/${entry.name}`;
          try {
            // statSync follows the key symlinks into `..data`.
            if (!Deno.statSync(path).isFile) continue;
          } catch {
            continue;
          }
          add(entry.name, path);
        }
      } catch (error) {
        logger.error(
          "Can't read the sidecar auth token directory {dir}: {error}",
          {
            dir: this.authTokenDir,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
    return tokens;
  }

  /**
   * Checks a TCP session's bearer token against every accepted one. Returns
   * the matching token's name (`""` when no token is configured), or
   * `undefined` to refuse. Every token is compared, matched or not, so the
   * time taken doesn't reveal which one matched.
   */
  private authorize(context: HandlerContext | undefined): string | undefined {
    if (this.authTokenFiles.length === 0 && !this.authTokenDir) return "";
    const presented = context?.requestHeader.get("authorization") ?? "";
    let matched: string | undefined;
    for (const token of this.acceptedTokens()) {
      if (
        safeEqual(presented, `Bearer ${token.value}`) && matched === undefined
      ) {
        matched = token.name;
      }
    }
    return matched;
  }

  /**
   * The Session bidi-streaming handler: one call per worker process. Reads
   * `register` as the required first message, acks it, then concurrently
   * drains `requests` (heartbeat/invoke_result/invoke_error/unregister,
   * updating gateway state as they arrive) while yielding whatever `invoke()`
   * pushes onto this worker's outbox — the same worker-initiates,
   * gateway-pushes-invoke shape the old length-prefixed protocol had, now
   * carried over one gRPC stream instead of a raw socket.
   *
   * On a TCP listener the bearer token is checked before anything is read
   * (UNAUTHENTICATED otherwise), and the worker is drained and disconnected
   * after its max connection age.
   */
  private async *handleSession(
    requests: AsyncIterable<SessionRequestMessage>,
    context?: HandlerContext,
    policy: ListenerPolicy = UNIX_POLICY,
  ): AsyncIterable<SessionResponseMessage> {
    const tokenName = policy.kind === "tcp" ? this.authorize(context) : "";
    if (tokenName === undefined) {
      logger.warn("Refused a sidecar session with a missing or wrong token");
      throw new ConnectError(
        "missing or invalid bearer token",
        Code.Unauthenticated,
      );
    }

    const iterator = requests[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done || first.value.payload.case !== "register") {
      throw new ConnectError(
        "first message on a sidecar Session stream must be register",
        Code.InvalidArgument,
      );
    }

    const worker = this.registerWorker(first.value.payload.value);
    if (tokenName) {
      logger.info("Worker {workerId} authenticated with token {token}", {
        workerId: worker.workerId,
        token: tokenName,
      });
    }
    worker.http2Session = this.currentHttp2Session.getStore();
    if (policy.kind === "tcp" && this.maxConnectionAgeMs > 0) {
      this.scheduleMaxAge(worker);
    }

    yield new SessionResponse({
      payload: {
        case: "registerAck",
        value: this.buildRegisterAck(first.value.payload.value),
      },
    });

    const readerLoop = (async () => {
      try {
        while (true) {
          const { value, done } = await iterator.next();
          if (done) break;
          this.handleWorkerMessage(worker, value);
          if (value.payload.case === "unregister") break;
        }
      } catch (error) {
        logger.warn(
          "Sidecar stream read error for worker={workerId}: {error}",
          {
            workerId: worker.workerId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      } finally {
        // Only tear down this session's own registration — if the same
        // workerId has since re-registered on a new session, that newer
        // registration must survive this stream closing (#391).
        this.unregisterWorker(worker);
      }
    })();

    // Not awaited once the outbox ends: if the gateway closed it (stop(), or
    // a same-workerId re-registration), the worker only ends its request
    // stream after it sees this response stream end — waiting for the reader
    // here deadlocked stop() while any worker was connected (#397). The
    // reader finishes on its own when the worker closes its side (or the
    // connection is destroyed), and it never throws.
    for await (const response of worker.outbox) {
      yield response;
    }
    void readerLoop;
  }

  /**
   * After the max connection age (±10 % jitter), stop routing to the worker,
   * let its in-flight invokes finish (up to connectionDrainGraceMs), then
   * end its stream and close its connection (GOAWAY). The worker reconnects,
   * and the Service may send it to another gateway replica.
   */
  private scheduleMaxAge(worker: WorkerState): void {
    const ageMs = Math.round(
      this.maxConnectionAgeMs * (0.9 + Math.random() * 0.2),
    );
    const ageTimer = setTimeout(() => {
      worker.timers.delete(ageTimer);
      if (!worker.alive) return;
      worker.draining = true;
      logger.info(
        "Worker {workerId} reached its max connection age; draining",
        { workerId: worker.workerId },
      );
      const deadline = Date.now() + this.connectionDrainGraceMs;
      const poll = () => {
        if (!worker.alive) return;
        if (worker.pendingByInvokeId.size > 0 && Date.now() < deadline) {
          const next = setTimeout(() => {
            worker.timers.delete(next);
            poll();
          }, DRAIN_POLL_MS);
          worker.timers.add(next);
          return;
        }
        const session = worker.http2Session;
        this.unregisterWorker(worker);
        // GOAWAY once the stream has ended, so the worker's next session
        // opens a new connection (and can land on another replica).
        if (session && !session.closed && !session.destroyed) {
          session.close();
        }
      };
      poll();
    }, ageMs);
    worker.timers.add(ageTimer);
  }

  private buildRegisterAck(register: RegisterMessage): RegisterAckMessage {
    return new RegisterAck({
      accepted: true,
      gatewayProtocolVersion: "1.0",
      registeredActors: register.actors.map((a: RegisteredActor) => keyOf(a)),
      rejectedActors: [],
    });
  }

  private handleWorkerMessage(
    worker: WorkerState,
    msg: SessionRequestMessage,
  ): void {
    switch (msg.payload.case) {
      case "heartbeat":
        return;

      case "invokeResult": {
        const body = msg.payload.value;
        logger.info(
          "Received invoke_result from worker {workerId} (invoke_id={invokeId})",
          { workerId: worker.workerId, invokeId: body.invokeId },
        );
        this.resolvePendingInvoke(worker.workerId, body.invokeId, {
          output: parseOutputJson(body.outputJson),
        });
        return;
      }

      case "invokeError": {
        const body = msg.payload.value;
        logger.warn(
          "Received invoke_error from worker {workerId} (invoke_id={invokeId}): {code} {message} (retriable={retriable})",
          {
            workerId: worker.workerId,
            invokeId: body.invokeId,
            code: body.error?.code ?? "UNKNOWN",
            message: body.error?.message ?? "",
            retriable: body.error?.retriable ?? false,
          },
        );
        this.rejectPendingInvoke(
          worker.workerId,
          body.invokeId,
          new ActivityInvokeError(
            body.error?.message ||
              `worker error (${body.error?.code ?? "UNKNOWN"})`,
            body.error?.code ?? "UNKNOWN",
            body.error?.retriable,
          ),
        );
        return;
      }

      case "unregister":
      case "register":
        return;
    }
  }

  private registerWorker(register: RegisterMessage): WorkerState {
    const existing = this.workers.get(register.workerId);
    if (existing) {
      this.unregisterWorker(existing);
    }

    const worker: WorkerState = {
      workerId: register.workerId,
      language: register.language,
      outbox: new AsyncQueue<SessionResponseMessage>(),
      actors: new Set(),
      maxConcurrencyByKey: new Map(),
      pendingByInvokeId: new Map(),
      alive: true,
      draining: false,
      timers: new Set(),
    };

    this.workers.set(register.workerId, worker);

    for (const meta of register.actors) {
      const key = keyOf(meta);
      const route = this.actorRoutes.get(key);
      if (route) {
        route.workerIds.add(register.workerId);
        route.meta = meta;
      } else {
        this.actorRoutes.set(key, {
          workerIds: new Set([register.workerId]),
          meta,
          cursor: 0,
        });
      }
      worker.actors.add(key);
      worker.maxConcurrencyByKey.set(key, concurrencyOf(meta.maxConcurrency));
      this.onActorRegistered?.(meta);
    }

    logger.info(
      "Registered worker {workerId} ({language}) with {count} actor(s)",
      {
        workerId: register.workerId,
        language: register.language,
        count: register.actors.length,
      },
    );

    return worker;
  }

  private unregisterWorker(worker: WorkerState): void {
    // Already superseded (same workerId re-registered on a newer session) or
    // already unregistered — nothing of ours left in the routing tables.
    if (this.workers.get(worker.workerId) !== worker) {
      return;
    }
    const workerId = worker.workerId;

    worker.alive = false;
    for (const timer of worker.timers) clearTimeout(timer);
    worker.timers.clear();

    // Remove only this worker from each route; the key disappears only once
    // no other worker still serves it.
    for (const key of worker.actors) {
      const route = this.actorRoutes.get(key);
      if (!route) continue;
      route.workerIds.delete(workerId);
      if (route.workerIds.size === 0) {
        this.actorRoutes.delete(key);
      }
    }

    for (const pending of worker.pendingByInvokeId.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new ActivityInvokeError(
          `worker disconnected while invoking ${pending.key}`,
          "WORKER_DISCONNECTED",
          true,
        ),
      );
    }

    worker.pendingByInvokeId.clear();
    worker.outbox.close();
    this.workers.delete(workerId);

    logger.info("Unregistered worker {workerId}", { workerId });
  }

  private resolvePendingInvoke(
    workerId: string,
    invokeId: string,
    result: ActivityInvokeResult,
  ): void {
    const worker = this.workers.get(workerId);
    const pending = worker?.pendingByInvokeId.get(invokeId);
    if (!pending || !worker) {
      return;
    }

    worker.pendingByInvokeId.delete(invokeId);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  private rejectPendingInvoke(
    workerId: string,
    invokeId: string,
    error: Error,
  ): void {
    const worker = this.workers.get(workerId);
    const pending = worker?.pendingByInvokeId.get(invokeId);
    if (!pending || !worker) {
      return;
    }

    worker.pendingByInvokeId.delete(invokeId);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private cleanupSocket(path: string): void {
    try {
      Deno.removeSync(path);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }
}
