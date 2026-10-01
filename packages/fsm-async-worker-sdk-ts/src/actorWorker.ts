// TypeScript worker SDK: connects to the Activity Gateway's sidecar, over its
// Unix socket or over TCP (TLS, bearer token and/or mutual TLS — SPEC-007),
// via the generated pgfsm.sidecargateway.v1.SidecarGatewayService
// bidi-streaming client (@pgfsm/proto-codegen, from
// packages/fsm-proto-codegen/proto/fsm-async-worker-gateway-ts/pgfsm/sidecargateway/v1/sidecar_gateway.proto,
// #100), registers actors from a compiler-generated registry, and serves
// invoke requests.
//
// Moved here from fsm-compiler-ts's worker-sdk-sdk.eta (#358) — before that,
// `generate-async-logic` wrote this whole file into every project as
// `async-worker/typescript/sdk.ts`. Now a generated project only carries a
// thin `run-async-worker.ts` that imports this package.
//
// Actor discovery is not a runtime folder scan + dynamic `import()` —
// `fsm-compiler-ts` generates a static, self-describing registry
// (`ActorRegistration[]`, see `packages/fsm-compiler-ts/src/operation-logic-scaffold.ts`'s
// `writeActorsRegistry`/`writeAggregateActorsRegistry`) that this SDK just
// iterates. `ActorWorker` takes that array directly; `runActorWorkerCli`
// (cli.ts) is what the generated entry point wires to its fixed,
// statically-imported registry file — this module stays registry-source-
// agnostic so it's easy to test with a synthetic array.
//
// This is the reference implementation for a compiled-language worker SDK
// (e.g. Rust) to follow — see ADR-003's Activity Gateway revision.

import { getLogger } from "@logtape/logtape";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import * as net from "node:net";
import type * as http2 from "node:http2";
import * as tls from "node:tls";
import { SidecarGatewayService } from "@pgfsm/proto-codegen/sidecargateway/v1/connect";
import {
  Heartbeat,
  type Invoke,
  InvokeError,
  InvokeErrorDetail,
  InvokeResult,
  Register,
  SessionRequest,
  type SessionResponse,
  Unregister,
} from "@pgfsm/proto-codegen/sidecargateway/v1/pb";

const logger = getLogger([
  "@pgfsm/worker",
  "async-op-worker-gateway",
  "worker-sdk-ts",
]);

// `deno check` fails to merge these generated classes' sibling .d.ts type
// declarations with their .js value bindings when a class name is used
// directly as a type (the same gap fsm-async-worker-gateway-ts's
// gatewayClient.ts documents for Connect's `Client<T>` utility type) —
// deriving instance types from the constructors via `InstanceType<typeof X>`
// sidesteps it, and every type position below goes through one of these
// aliases rather than the bare class name.
type SessionRequestMessage = InstanceType<typeof SessionRequest>;
type SessionResponseMessage = InstanceType<typeof SessionResponse>;
type InvokeMessage = InstanceType<typeof Invoke>;

/**
 * Plain structural mirror of the generated `RegisteredActor` proto message
 * — hand-written rather than derived via `InstanceType<typeof X>` since it
 * crosses this module's own exported surface (`ActorRegistration`) the same
 * way fsm-async-worker-gateway-ts's sidecar/gateway.ts's identical type does.
 */
export interface RegisteredActor {
  parentFsmName: string;
  parentFsmVersion: string;
  asyncOperationType: string;
  asyncOperationName: string;
  asyncOperationVersion: string;
  asyncOperationLanguage: string;
  /**
   * How many invokes of this actor run at once. Overrides the worker's
   * `maxConcurrency`; unset falls back to it, then to 1 (SPEC-007). Handlers
   * must be safe to run concurrently once this is above 1.
   */
  maxConcurrency?: number;
}

// Same Deno-vs-tsc inference gap gatewayClient.ts's RawActivityGatewayClient
// works around for Connect's unary `Client<T>` — the bidi-streaming case
// hits it too. Hand-rolled to the exact shape actually called, instead of
// fighting Connect's generic inference under Deno.
interface RawSidecarGatewayClient {
  session(
    requests: AsyncIterable<SessionRequestMessage>,
    options?: { headers?: HeadersInit },
  ): AsyncIterable<SessionResponseMessage>;
}

export type ActorHandler = (input: unknown) => unknown | Promise<unknown>;

/**
 * One entry from a compiler-generated actor registry (see module doc
 * comment). The generated registries declare a structurally identical type
 * of their own rather than importing this one, so a registry written by
 * `create-async-logic` alone (which writes no `deno.json`) still resolves.
 */
export type ActorRegistration = RegisteredActor & {
  handler: ActorHandler;
};

const DEFAULT_HEARTBEAT_MS = 5_000;
export const DEFAULT_KEEPALIVE_INTERVAL_MS = 30_000;
export const DEFAULT_KEEPALIVE_TIMEOUT_MS = 10_000;
export const DEFAULT_SHUTDOWN_GRACE_MS = 25_000;
export const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 250;
export const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
/**
 * A session must stay up this long before the reconnect backoff resets, so a
 * gateway that accepts and immediately drops (flapping) still backs off
 * instead of being hammered in a tight loop.
 */
export const STABLE_SESSION_MS = 10_000;

/**
 * gRPC codes that reconnecting can't fix (bad credentials, wrong server or
 * protocol) — `run()` fails fast on these rather than retrying forever and
 * hiding a misconfiguration behind warnings. Same list in all four SDKs.
 */
const FATAL_CODES = new Set<Code>([
  Code.Unauthenticated,
  Code.PermissionDenied,
  Code.Unimplemented,
  Code.InvalidArgument,
]);

function isFatal(error: unknown): boolean {
  return error instanceof RegistrationRejectedError ||
    (error instanceof ConnectError && FATAL_CODES.has(error.code));
}

export interface ActorWorkerOptions {
  workerId: string;
  language: string;
  /** Shorthand for `gatewayAddress: "unix:<path>"`. */
  gatewaySocketPath?: string;
  /**
   * Where the gateway's sidecar listens: `unix:<path>`, `https://host:port`
   * (TLS), or `http://host:port` (the gateway's --insecure-plaintext test
   * mode). Takes precedence over `gatewaySocketPath`.
   */
  gatewayAddress?: string;
  /** PEM CA bundle to trust the gateway's TLS certificate (default: system roots). */
  caFile?: string;
  /**
   * File holding the bearer token sent as `authorization: Bearer <token>`.
   * Re-read for every session, so a rotated Secret is picked up on reconnect.
   */
  tokenFile?: string;
  /** PEM client certificate and key for mutual TLS; re-read for every session. */
  certFile?: string;
  keyFile?: string;
  /**
   * HTTP/2 PING interval on TCP connections; a PING unanswered for
   * `keepaliveTimeoutMs` drops the session so the worker reconnects. 0
   * disables. Defaults 30 s / 10 s. Not used for Unix sockets.
   */
  keepaliveIntervalMs?: number;
  keepaliveTimeoutMs?: number;
  /**
   * Invokes of each actor run at once, for actors that don't set their own
   * `maxConcurrency`. Default 1 (one at a time, the historical behaviour).
   */
  maxConcurrency?: number;
  /**
   * On `stop()`, how long in-flight invokes get to finish before the worker
   * disconnects anyway (default 25 s).
   */
  shutdownGraceMs?: number;
  heartbeatMs?: number;
  /** First reconnect backoff step (default 250 ms). */
  reconnectInitialDelayMs?: number;
  /** Backoff cap (default 30 s). */
  reconnectMaxDelayMs?: number;
  /**
   * Give up after this many consecutive failed attempts; 0 (the default)
   * retries forever. A session that fails to register, or registers but ends
   * within STABLE_SESSION_MS, counts as a failed attempt; a longer one resets
   * the count.
   */
  reconnectMaxAttempts?: number;
}

/**
 * The gateway explicitly refused this worker's registration — not retried,
 * since reconnecting would just be refused again.
 */
export class RegistrationRejectedError extends Error {
  constructor() {
    super("gateway rejected registration");
    this.name = "RegistrationRejectedError";
  }
}

/**
 * Full-jitter exponential backoff (#392): a random delay in
 * [0, min(maxMs, initialMs * 2^(attempt-1))]. Same formula in all four SDKs.
 */
export function reconnectDelayMs(
  attempt: number,
  initialMs: number,
  maxMs: number,
): number {
  const ceiling = Math.min(maxMs, initialMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * ceiling);
}

/** A parsed `gatewayAddress`. */
export type GatewayAddress =
  | { kind: "unix"; path: string }
  | { kind: "tcp"; url: string; tls: boolean };

/** Parses `unix:<path>`, `https://host:port` or `http://host:port`. */
export function parseGatewayAddress(address: string): GatewayAddress {
  if (address.startsWith("unix:")) {
    const path = address.slice("unix:".length);
    if (path) return { kind: "unix", path };
  }
  const match = /^(https?):\/\/[^/]+:\d+\/?$/.exec(address);
  if (match) {
    return {
      kind: "tcp",
      url: address.replace(/\/$/, ""),
      tls: match[1] === "https",
    };
  }
  throw new Error(
    `gateway address must be unix:<path>, https://host:port or http://host:port, got: ${address}`,
  );
}

/** The limit an actor runs under: its own, else the worker's, else 1. */
export function effectiveMaxConcurrency(
  actorMax: number | undefined,
  workerMax: number | undefined,
): number {
  for (const value of [actorMax, workerMax]) {
    if (value !== undefined && Number.isInteger(value) && value > 0) {
      return value;
    }
  }
  return 1;
}

/** Counting semaphore: at most `permits` holders, extra acquirers wait. */
class Semaphore {
  private readonly waiters: Array<() => void> = [];
  constructor(private permits: number) {}

  acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.permits++;
  }
}

function actorKey(reg: RegisteredActor): string {
  return `${reg.parentFsmName}@${reg.parentFsmVersion}@${reg.asyncOperationType}@${reg.asyncOperationName}@${reg.asyncOperationVersion}@${reg.asyncOperationLanguage}`;
}

function parseInputJson(json: string): unknown {
  if (!json.trim()) {
    return null;
  }
  return JSON.parse(json);
}

/**
 * Minimal async push queue feeding this worker's outgoing SessionRequest
 * stream — `runSession()`/its heartbeat timer/`handleInvoke()` push register,
 * heartbeat, invoke_result, and invoke_error messages onto it; the transport
 * drains it as the actual HTTP/2 request stream. Mirrors
 * fsm-async-worker-gateway-ts's sidecar/gateway.ts's identically-shaped queue on
 * the server side — a separate copy rather than a shared import, since this
 * package deliberately doesn't depend on the gateway package (which pulls in
 * pg).
 */
class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private readonly waiting: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  get isClosed(): boolean {
    return this.closed;
  }

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
      // connect-node's client transport wraps the request iterable with its
      // own abort handling, which requires the full async-iterator protocol
      // (native async generators get `throw`/`return` for free; this
      // hand-rolled queue needs them spelled out) — without these it fails
      // with "AsyncIterable does not implement throw" as soon as a call
      // completes or is cancelled.
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

/**
 * Connects to the gateway's sidecar, registers `registrations`, and serves
 * invoke requests until `stop()` is called. If the gateway isn't up yet, or a
 * session ends (gateway restart, dropped connection, max connection age), it
 * reconnects with backoff on a new connection and re-registers (#392).
 *
 * Invokes run concurrently, up to each actor's limit (its own
 * `maxConcurrency`, else the worker's, else 1); extra invokes of an actor wait
 * for a slot. `stop()` drains: new invokes are refused as retriable
 * (`WORKER_DRAINING`, so the gateway delivers them again elsewhere) while
 * in-flight ones finish, up to `shutdownGraceMs`.
 */
export class ActorWorker {
  private outbox: AsyncQueue<SessionRequestMessage> | null = null;
  private stopped = false;
  private stopping: Promise<void> | null = null;
  private wakeBackoff: (() => void) | null = null;
  private readonly handlers = new Map<string, ActorHandler>();
  private readonly slots = new Map<string, Semaphore>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly address: GatewayAddress;

  constructor(
    private readonly options: ActorWorkerOptions,
    private readonly registrations: ActorRegistration[],
  ) {
    const address = options.gatewayAddress ??
      (options.gatewaySocketPath
        ? `unix:${options.gatewaySocketPath}`
        : undefined);
    if (!address) {
      throw new Error("ActorWorker needs gatewayAddress or gatewaySocketPath");
    }
    this.address = parseGatewayAddress(address);
  }

  /**
   * Serves until `stop()`. Rejects only on something reconnecting can't fix:
   * an empty registry, an explicit registration rejection, a fatal gRPC code
   * (UNAUTHENTICATED, PERMISSION_DENIED, UNIMPLEMENTED, INVALID_ARGUMENT), or
   * `reconnectMaxAttempts` consecutive failed attempts.
   */
  async run(): Promise<void> {
    if (this.registrations.length === 0) {
      throw new Error("no actors to register, refusing to start worker");
    }

    const registeredActors: RegisteredActor[] = [];
    for (const reg of this.registrations) {
      const key = actorKey(reg);
      const maxConcurrency = effectiveMaxConcurrency(
        reg.maxConcurrency,
        this.options.maxConcurrency,
      );
      this.handlers.set(key, reg.handler);
      this.slots.set(key, new Semaphore(maxConcurrency));
      registeredActors.push({
        parentFsmName: reg.parentFsmName,
        parentFsmVersion: reg.parentFsmVersion,
        asyncOperationType: reg.asyncOperationType,
        asyncOperationName: reg.asyncOperationName,
        asyncOperationVersion: reg.asyncOperationVersion,
        asyncOperationLanguage: reg.asyncOperationLanguage,
        maxConcurrency,
      });
    }

    const initialDelayMs = this.options.reconnectInitialDelayMs ??
      DEFAULT_RECONNECT_INITIAL_DELAY_MS;
    const maxDelayMs = this.options.reconnectMaxDelayMs ??
      DEFAULT_RECONNECT_MAX_DELAY_MS;
    const maxAttempts = this.options.reconnectMaxAttempts ?? 0;
    let failures = 0;

    while (!this.stopped && !this.stopping) {
      const session = { registered: false };
      let lastError: unknown = null;
      const started = Date.now();
      try {
        await this.runSession(registeredActors, session);
      } catch (error) {
        if (isFatal(error)) {
          throw error;
        }
        lastError = error;
      }
      if (this.stopped || this.stopping) {
        break;
      }

      const stable = session.registered &&
        Date.now() - started >= STABLE_SESSION_MS;
      failures = stable ? 0 : failures + 1;
      if (maxAttempts > 0 && failures >= maxAttempts) {
        throw new Error(
          `giving up after ${failures} consecutive failed attempt(s) to connect to the gateway: ${
            describe(lastError)
          }`,
        );
      }

      const delayMs = reconnectDelayMs(
        Math.max(failures, 1),
        initialDelayMs,
        maxDelayMs,
      );
      logger.warn(
        session.registered
          ? "Gateway session ended ({error}); reconnecting in {delayMs}ms"
          : "Could not connect to the gateway ({error}); retrying in {delayMs}ms",
        { error: describe(lastError ?? "stream closed"), delayMs },
      );
      await this.backoff(delayMs);
    }
    await this.stopping;
  }

  /**
   * Stops gracefully: new invokes are refused as retriable while in-flight
   * ones finish (up to `shutdownGraceMs`), then the worker unregisters and
   * closes its session. Resolves once that's done; calling it again returns
   * the same promise.
   */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.wakeBackoff?.();
    this.stopping = (async () => {
      if (this.inFlight.size > 0) {
        const graceMs = this.options.shutdownGraceMs ??
          DEFAULT_SHUTDOWN_GRACE_MS;
        logger.info(
          "Draining {count} in-flight invoke(s) before stopping (up to {graceMs}ms)",
          { count: this.inFlight.size, graceMs },
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.allSettled([...this.inFlight]),
          new Promise((resolve) => (timer = setTimeout(resolve, graceMs))),
        ]);
        clearTimeout(timer);
      }
      this.stopped = true;
      this.outbox?.push(
        new SessionRequest({
          payload: {
            case: "unregister",
            value: new Unregister({ workerId: this.options.workerId }),
          },
        }),
      );
      this.outbox?.close();
      this.wakeBackoff?.();
    })();
    return this.stopping;
  }

  /** Sleeps `ms`, returning early if `stop()` is called. */
  private backoff(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wakeBackoff = () => {
        this.wakeBackoff = null;
        done();
      };
    });
  }

  /**
   * A new HTTP/2 connection for one session, so a reconnect after the
   * gateway's max connection age can reach another replica. TLS material and
   * the token are read now, so rotated files apply from the next session.
   */
  private openTransport(): {
    sessionManager: Http2SessionManager;
    baseUrl: string;
    headers: Record<string, string>;
  } {
    const headers: Record<string, string> = {};
    if (this.options.tokenFile) {
      const token = Deno.readTextFileSync(this.options.tokenFile).trim();
      headers.authorization = `Bearer ${token}`;
    }
    if (this.address.kind === "unix") {
      const path = this.address.path;
      return {
        sessionManager: new Http2SessionManager(
          "http://localhost",
          undefined,
          { createConnection: () => net.connect(path) },
        ),
        baseUrl: "http://localhost",
        headers,
      };
    }

    const intervalMs = this.options.keepaliveIntervalMs ??
      DEFAULT_KEEPALIVE_INTERVAL_MS;
    const ping = intervalMs > 0
      ? {
        pingIntervalMs: intervalMs,
        pingTimeoutMs: this.options.keepaliveTimeoutMs ??
          DEFAULT_KEEPALIVE_TIMEOUT_MS,
      }
      : undefined;
    const tlsOptions: http2.SecureClientSessionOptions = {};
    if (this.address.tls) {
      const url = new URL(this.address.url);
      const secure: tls.ConnectionOptions = {
        host: url.hostname,
        port: Number(url.port),
        servername: net.isIP(url.hostname) ? undefined : url.hostname,
        ALPNProtocols: ["h2"],
      };
      if (this.options.caFile) {
        secure.ca = Deno.readTextFileSync(this.options.caFile);
      }
      if (this.options.certFile && this.options.keyFile) {
        secure.cert = Deno.readTextFileSync(this.options.certFile);
        secure.key = Deno.readTextFileSync(this.options.keyFile);
      }
      // Our own TLS socket, whose errors never reach the HTTP/2 session as
      // errors. Under TLS 1.3 the gateway can refuse us (e.g. "certificate
      // required" with mutual TLS) only after the handshake: connect-node
      // removes its session "error" listener on "connect", before attaching
      // the next one, so that late alert became an unhandled session error
      // and crashed the process. Instead, log it and close the socket
      // without an error: the session sees a plain close, the call fails,
      // and run() retries with backoff like any other dropped connection.
      tlsOptions.createConnection = () => {
        const socket = tls.connect(secure);
        const emit = socket.emit.bind(socket);
        socket.emit = ((event: string | symbol, ...args: unknown[]) => {
          if (event === "error") {
            logger.warn("Gateway TLS connection failed: {error}", {
              error: args[0] instanceof Error
                ? args[0].message
                : String(args[0]),
            });
            socket.destroy();
            return true;
          }
          return emit(event, ...args);
        }) as typeof socket.emit;
        return socket;
      };
    }
    return {
      sessionManager: new Http2SessionManager(
        this.address.url,
        ping,
        tlsOptions,
      ),
      baseUrl: this.address.url,
      headers,
    };
  }

  /**
   * One connect → register → serve cycle. Sets `session.registered` once the
   * gateway acks; `run()` resets the backoff only if a registered session
   * also lasted STABLE_SESSION_MS.
   */
  private async runSession(
    registeredActors: RegisteredActor[],
    session: { registered: boolean },
  ): Promise<void> {
    const { sessionManager, baseUrl, headers } = this.openTransport();
    const transport = createGrpcTransport({
      baseUrl,
      httpVersion: "2",
      sessionManager,
    });
    const client = createClient(
      SidecarGatewayService,
      transport,
    ) as unknown as RawSidecarGatewayClient;

    const outbox = new AsyncQueue<SessionRequestMessage>();
    this.outbox = outbox;

    outbox.push(
      new SessionRequest({
        payload: {
          case: "register",
          value: new Register({
            workerId: this.options.workerId,
            language: this.options.language,
            protocolVersion: "1.0",
            actors: registeredActors,
          }),
        },
      }),
    );

    const responses = client.session(outbox, { headers });
    const iterator = responses[Symbol.asyncIterator]();
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    try {
      const first = await iterator.next();
      if (first.done || first.value.payload.case !== "registerAck") {
        throw new Error(
          `expected register_ack but got ${
            first.done ? "EOF" : first.value.payload.case
          }`,
        );
      }
      if (!first.value.payload.value.accepted) {
        throw new RegistrationRejectedError();
      }
      session.registered = true;

      logger.info(
        "Worker {workerId} registered {count} actor(s) with the gateway",
        { workerId: this.options.workerId, count: registeredActors.length },
      );

      heartbeat = setInterval(() => {
        outbox.push(
          new SessionRequest({
            payload: {
              case: "heartbeat",
              value: new Heartbeat({ workerId: this.options.workerId }),
            },
          }),
        );
      }, this.options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);

      await this.serveLoop(iterator, outbox);
    } finally {
      clearInterval(heartbeat);
      outbox.push(
        new SessionRequest({
          payload: {
            case: "unregister",
            value: new Unregister({ workerId: this.options.workerId }),
          },
        }),
      );
      outbox.close();
      if (this.outbox === outbox) {
        this.outbox = null;
      }
      sessionManager.abort();
    }
  }

  private async serveLoop(
    iterator: AsyncIterator<SessionResponseMessage>,
    outbox: AsyncQueue<SessionRequestMessage>,
  ): Promise<void> {
    while (!this.stopped) {
      const { value, done } = await iterator.next();
      if (done) {
        break;
      }
      if (value.payload.case !== "invoke") {
        continue;
      }
      const body = value.payload.value;
      if (this.stopping) {
        // Draining: refuse as retriable, so the gateway leaves the message
        // on its queue for another worker (#396).
        sendError(
          outbox,
          body.invokeId,
          "WORKER_DRAINING",
          "worker is shutting down",
          true,
        );
        continue;
      }
      // Not awaited: invokes run concurrently, each actor bounded by its
      // own slots (see handleInvoke).
      const running: Promise<void> = this.handleInvoke(body, outbox).finally(
        () => this.inFlight.delete(running),
      );
      this.inFlight.add(running);
    }
  }

  private async handleInvoke(
    body: InvokeMessage,
    outbox: AsyncQueue<SessionRequestMessage>,
  ): Promise<void> {
    const key = actorKey({
      parentFsmName: body.parentFsmName,
      parentFsmVersion: body.parentFsmVersion,
      asyncOperationType: body.asyncOperationType,
      asyncOperationName: body.asyncOperationName,
      asyncOperationVersion: body.asyncOperationVersion,
      asyncOperationLanguage: body.asyncOperationLanguage,
    });
    const handler = this.handlers.get(key);
    const slots = this.slots.get(key);

    if (!handler || !slots) {
      sendError(
        outbox,
        body.invokeId,
        "NOT_FOUND",
        `actor not found: ${key}`,
      );
      return;
    }

    // Never run more of this actor than declared, even if the gateway sends
    // more (after its own invoke timeout, or through a direct Invoke() RPC).
    await slots.acquire();
    const started = performance.now();
    try {
      const output = await Promise.resolve(
        handler(parseInputJson(body.inputJson)),
      );
      const durationMs = Math.max(0, Math.round(performance.now() - started));
      if (warnIfSessionGone(outbox, body.invokeId, key)) return;
      outbox.push(
        new SessionRequest({
          payload: {
            case: "invokeResult",
            value: new InvokeResult({
              invokeId: body.invokeId,
              outputJson: JSON.stringify(output ?? null),
              durationMs,
            }),
          },
        }),
      );
    } catch (error) {
      if (warnIfSessionGone(outbox, body.invokeId, key)) return;
      sendError(
        outbox,
        body.invokeId,
        "INTERNAL",
        error instanceof Error ? error.message : "unknown worker error",
      );
    } finally {
      slots.release();
    }
  }
}

function sendError(
  outbox: AsyncQueue<SessionRequestMessage>,
  invokeId: string,
  code: string,
  message: string,
  retriable = false,
): void {
  outbox.push(
    new SessionRequest({
      payload: {
        case: "invokeError",
        value: new InvokeError({
          invokeId,
          error: new InvokeErrorDetail({ code, message, retriable }),
        }),
      },
    }),
  );
}

/**
 * An invoke outlived the session it arrived on: its result can't go out on a
 * later session (the gateway matches results to the connection it sent the
 * invoke on, and has already failed it as WORKER_DISCONNECTED). Log instead of
 * dropping it silently.
 */
function warnIfSessionGone(
  outbox: AsyncQueue<SessionRequestMessage>,
  invokeId: string,
  key: string,
): boolean {
  if (!outbox.isClosed) return false;
  logger.warn(
    "Dropping result of invoke {invokeId} for {actor}: its gateway session ended",
    { invokeId, actor: key },
  );
  return true;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
