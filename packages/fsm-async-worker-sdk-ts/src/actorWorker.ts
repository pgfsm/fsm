// TypeScript worker SDK: connects to the Activity Gateway's sidecar Unix
// socket via the generated pgfsm.sidecargateway.v1.SidecarGatewayService
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
}

// Same Deno-vs-tsc inference gap gatewayClient.ts's RawActivityGatewayClient
// works around for Connect's unary `Client<T>` — the bidi-streaming case
// hits it too. Hand-rolled to the exact shape actually called, instead of
// fighting Connect's generic inference under Deno.
interface RawSidecarGatewayClient {
  session(
    requests: AsyncIterable<SessionRequestMessage>,
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
  gatewaySocketPath: string;
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
 * Connects to the gateway's sidecar socket, registers `registrations`, and
 * serves invoke requests until `stop()` is called. If the gateway isn't up
 * yet, or a session ends (gateway restart, dropped connection), it
 * reconnects with backoff and re-registers (#392).
 */
export class ActorWorker {
  private outbox: AsyncQueue<SessionRequestMessage> | null = null;
  private stopped = false;
  private wakeBackoff: (() => void) | null = null;
  private readonly handlers = new Map<string, ActorHandler>();

  constructor(
    private readonly options: ActorWorkerOptions,
    private readonly registrations: ActorRegistration[],
  ) {}

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
      this.handlers.set(actorKey(reg), reg.handler);
      registeredActors.push({
        parentFsmName: reg.parentFsmName,
        parentFsmVersion: reg.parentFsmVersion,
        asyncOperationType: reg.asyncOperationType,
        asyncOperationName: reg.asyncOperationName,
        asyncOperationVersion: reg.asyncOperationVersion,
        asyncOperationLanguage: reg.asyncOperationLanguage,
      });
    }

    const initialDelayMs = this.options.reconnectInitialDelayMs ??
      DEFAULT_RECONNECT_INITIAL_DELAY_MS;
    const maxDelayMs = this.options.reconnectMaxDelayMs ??
      DEFAULT_RECONNECT_MAX_DELAY_MS;
    const maxAttempts = this.options.reconnectMaxAttempts ?? 0;
    let failures = 0;

    while (!this.stopped) {
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
      if (this.stopped) {
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
  }

  stop(): void {
    if (this.stopped) return;
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
   * One connect → register → serve cycle. Sets `session.registered` once the
   * gateway acks; `run()` resets the backoff only if a registered session
   * also lasted STABLE_SESSION_MS.
   */
  private async runSession(
    registeredActors: RegisteredActor[],
    session: { registered: boolean },
  ): Promise<void> {
    const sessionManager = new Http2SessionManager(
      "http://localhost",
      undefined,
      {
        createConnection: () => net.connect(this.options.gatewaySocketPath),
      },
    );
    const transport = createGrpcTransport({
      baseUrl: "http://localhost",
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

    const responses = client.session(outbox);
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
      if (value.payload.case === "cancel") {
        continue;
      }
      if (value.payload.case !== "invoke") {
        continue;
      }
      await this.handleInvoke(value.payload.value, outbox);
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
    const started = performance.now();

    if (!handler) {
      sendError(
        outbox,
        body.invokeId,
        "NOT_FOUND",
        `actor not found: ${key}`,
      );
      return;
    }

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
    }
  }
}

function sendError(
  outbox: AsyncQueue<SessionRequestMessage>,
  invokeId: string,
  code: string,
  message: string,
): void {
  outbox.push(
    new SessionRequest({
      payload: {
        case: "invokeError",
        value: new InvokeError({
          invokeId,
          error: new InvokeErrorDetail({ code, message, retriable: false }),
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
