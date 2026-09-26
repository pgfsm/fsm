// Sidecar gateway: accepts one worker-initiated bidi-streaming Session call
// per worker process, tracks which actors each worker has registered, and
// routes invocations to the right worker's stream. Bound to a Unix socket via
// node:http2 + connectNodeAdapter, the same mechanism gatewayServer.ts uses
// for the client-facing ActivityGateway leg — a separate http2.Server on a
// separate socket path, since Node's http2 Server binds exactly one path.
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
  type ServiceImpl,
} from "@connectrpc/connect";
import * as http2 from "node:http2";
import { SidecarGatewayService } from "@pgfsm/proto-codegen/sidecargateway/v1/connect";
import {
  Invoke,
  type Register,
  RegisterAck,
  type SessionRequest,
  SessionResponse,
} from "@pgfsm/proto-codegen/sidecargateway/v1/pb";
import { isNotFoundError } from "../util.ts";

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
  pendingByInvokeId: Map<string, PendingInvoke>;
  alive: boolean;
}

interface ActorRoute {
  workerId: string;
  meta: RegisteredActor;
}

export interface SidecarGatewayOptions {
  socketPath: string;
  /**
   * Called once per actor, synchronously, whenever a worker registers it
   * (including on re-registration). Fire-and-forget by design — registration
   * itself never waits on this callback's own async work (e.g. an
   * ensureQueueOnRegister DB call); callers that need to react to failures
   * should handle them inside the callback itself.
   */
  onActorRegistered?: (actor: RegisteredActor) => void;
}

export class SidecarGateway {
  private readonly socketPath: string;
  private readonly onActorRegistered?: (actor: RegisteredActor) => void;
  private server: http2.Http2Server | null = null;
  private readonly workers = new Map<string, WorkerState>();
  private readonly actorRoutes = new Map<string, ActorRoute>();

  constructor(options: SidecarGatewayOptions) {
    this.socketPath = options.socketPath;
    this.onActorRegistered = options.onActorRegistered;
  }

  async start(): Promise<void> {
    this.cleanupSocket();

    const routes = (router: ConnectRouter): void => {
      router.service(
        SidecarGatewayService,
        { session: this.handleSession.bind(this) } as unknown as Partial<
          ServiceImpl<typeof SidecarGatewayService>
        >,
      );
    };

    const server = http2.createServer(connectNodeAdapter({ routes }));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(this.socketPath, () => {
        server.off("error", onError);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const worker of this.workers.values()) {
      worker.alive = false;
      worker.outbox.close();
    }
    this.workers.clear();
    this.actorRoutes.clear();

    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    this.cleanupSocket();
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
      throw new ActivityInvokeError(
        `no worker registered for actor: ${key}`,
        "ACTOR_NOT_FOUND",
      );
    }

    const worker = this.workers.get(route.workerId);
    if (!worker || !worker.alive) {
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

  /**
   * The Session bidi-streaming handler: one call per worker process. Reads
   * `register` as the required first message, acks it, then concurrently
   * drains `requests` (heartbeat/invoke_result/invoke_error/unregister,
   * updating gateway state as they arrive) while yielding whatever `invoke()`
   * pushes onto this worker's outbox — the same worker-initiates,
   * gateway-pushes-invoke shape the old length-prefixed protocol had, now
   * carried over one gRPC stream instead of a raw socket.
   */
  private async *handleSession(
    requests: AsyncIterable<SessionRequestMessage>,
  ): AsyncIterable<SessionResponseMessage> {
    const iterator = requests[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done || first.value.payload.case !== "register") {
      throw new ConnectError(
        "first message on a sidecar Session stream must be register",
        Code.InvalidArgument,
      );
    }

    const worker = this.registerWorker(first.value.payload.value);

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
        this.unregisterWorker(worker.workerId);
      }
    })();

    try {
      for await (const response of worker.outbox) {
        yield response;
      }
    } finally {
      await readerLoop.catch(() => {});
    }
  }

  private buildRegisterAck(register: RegisterMessage): RegisterAckMessage {
    return new RegisterAck({
      accepted: true,
      gatewayProtocolVersion: "1.0",
      registeredActors: register.actors.map((a: RegisteredActor) =>
        actorKey(
          a.parentFsmName,
          a.parentFsmVersion,
          a.asyncOperationType,
          a.asyncOperationName,
          a.asyncOperationVersion,
          a.asyncOperationLanguage,
        )
      ),
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
      this.unregisterWorker(register.workerId);
    }

    const worker: WorkerState = {
      workerId: register.workerId,
      language: register.language,
      outbox: new AsyncQueue<SessionResponseMessage>(),
      actors: new Set(),
      pendingByInvokeId: new Map(),
      alive: true,
    };

    this.workers.set(register.workerId, worker);

    for (const meta of register.actors) {
      const key = actorKey(
        meta.parentFsmName,
        meta.parentFsmVersion,
        meta.asyncOperationType,
        meta.asyncOperationName,
        meta.asyncOperationVersion,
        meta.asyncOperationLanguage,
      );
      this.actorRoutes.set(key, { workerId: register.workerId, meta });
      worker.actors.add(key);
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

  private unregisterWorker(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) {
      return;
    }

    worker.alive = false;

    for (const key of worker.actors) {
      this.actorRoutes.delete(key);
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

  private cleanupSocket(): void {
    try {
      Deno.removeSync(this.socketPath);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }
}
