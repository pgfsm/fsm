// Activity Gateway server: a gRPC front door (client-facing) backed by the
// Unix-socket sidecar (worker-facing), optionally paired with the 30-second
// async-op poll loop (see asyncOpPollLoop.ts / GOAL.md) sharing that same
// sidecar instance. This package is a standalone alternative to
// fsm-async-worker-ts, not a passive service another orchestrator's
// poll/claim/archive loop calls into — when `options.asyncOpPollLoop` is
// set, this process owns its own Postgres connection and drives pending
// async-operation-type work for its currently-registered actors itself.
//
// Ported from the polygot-lang-ipc-worker prototype's server/src/main.ts,
// adapted to the ActivityGatewayService proto contract
// (packages/fsm-proto-codegen/proto/fsm-core-async-op-worker/pgfsm/activitygateway/v1/activity_gateway.proto)
// and to this repo's logger.
//
// Built on the compiler-generated Connect-ES stubs (imported as
// @pgfsm/proto-codegen, a Deno workspace-linked package, not published —
// see #103) via @connectrpc/connect-node's connectNodeAdapter, instead of @grpc/grpc-js +
// @grpc/proto-loader's runtime reflection (see gatewayClient.ts for the same
// migration on the client side, including why it's still wire-compatible
// with real gRPC clients: connectNodeAdapter serves the gRPC, gRPC-web, and
// Connect protocols from one handler by default). Bound to a plain
// node:http2 server instead of a grpc.Server — Unix-socket binding is
// Node's own `server.listen(path)`, no gRPC-specific "unix:" scheme needed
// server-side either.

import { connectNodeAdapter } from "@connectrpc/connect-node";
import type { ConnectRouter, ServiceImpl } from "@connectrpc/connect";
import * as http2 from "node:http2";
import { getLogger } from "@logtape/logtape";
import { type DBDeps, ensureAsyncOperationQueueForWorker } from "@pgfsm/db";
import {
  ActivityInvokeError,
  actorKey,
  type RegisteredActor,
  SidecarGateway,
} from "./sidecar/gateway.ts";
import { ActivityGatewayService } from "@pgfsm/proto-codegen/activitygateway/v1/connect";
import { startAsyncOpPollLoop } from "./asyncOpPollLoop.ts";
import { isNotFoundError } from "./util.ts";

const logger = getLogger(["@pgfsm/worker", "async-op-worker-gateway"]);

// Same Deno-vs-tsc `never` inference gap documented in gatewayClient.ts's
// RawActivityGatewayClient — router.service()'s Partial<ServiceImpl<T>>
// parameter hits it too. Hand-rolled and cast once at the router.service()
// call, instead of fighting Connect's generic inference under Deno.
interface RawActivityGatewayServiceImpl {
  invoke(request: {
    parentFsmName: string;
    parentFsmVersion: string;
    asyncOperationType: string;
    asyncOperationName: string;
    asyncOperationVersion: string;
    asyncOperationLanguage: string;
    inputJson: string;
    instanceId: string;
    correlationId: string;
    timeoutMs: number;
  }): Promise<{
    ok: boolean;
    outputJson: string;
    errorCode: string;
    errorMessage: string;
    retriable: boolean;
  }>;
  listRegisteredActors(
    request: Record<string, never>,
  ): Promise<{ actorKeys: string[] }>;
}

export interface GatewayServerOptions {
  /** gRPC bind target, e.g. "unix:/tmp/pgfsm-activity-gateway.sock" or "127.0.0.1:50061". */
  bindTarget: string;
  /** Unix socket the sidecar listens on for worker connections. */
  sidecarSocketPath: string;
  /** Default per-invoke timeout if the caller doesn't set one. */
  defaultInvokeTimeoutMs?: number;
  signal?: AbortSignal;
  /**
   * When set, also starts the async-op poll loop (asyncOpPollLoop.ts)
   * against this server's own SidecarGateway instance — same process, same
   * registered-worker state, no separate CLI/socket needed.
   */
  asyncOpPollLoop?: {
    deps: DBDeps;
    /** Poll interval in ms. Default 30_000, per GOAL.md. */
    intervalMs?: number;
    /** Per-invoke timeout for poll-loop-triggered invokes. Default 10_000. */
    invokeTimeoutMs?: number;
  };
  /**
   * When set, ensures a PGMQ queue exists (fsm_core.ensure_async_operation_queue_for_worker,
   * idempotent) for every actor a worker registers — fire-and-forget, doesn't
   * block or fail registration itself. Queue name is the actor's full
   * identity joined with '_': parentFsmName_parentFsmVersion_asyncOperationType_asyncOperationName_asyncOperationVersion_asyncOperationLanguage.
   */
  ensureQueueOnRegister?: {
    deps: DBDeps;
  };
}

const DEFAULT_INVOKE_TIMEOUT_MS = 10_000;

function parseInput(inputJson: string): unknown {
  if (!inputJson.trim()) {
    return null;
  }
  return JSON.parse(inputJson);
}

function cleanupUnixSocket(bindTarget: string): void {
  if (!bindTarget.startsWith("unix:")) {
    return;
  }
  const path = bindTarget.slice("unix:".length);
  try {
    Deno.removeSync(path);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

/**
 * Binds an http2 server to a grpc-js-style target ("unix:<path>" or
 * "host:port") — mirrors gatewayClient.ts's targetToHttp2Options, but for
 * listening rather than connecting. Node's http2 Server has no "unix:"
 * scheme either; `server.listen(path)` vs. `server.listen(port, host)` is
 * how it distinguishes the two itself.
 */
function bindHttp2Server(
  server: http2.Http2Server,
  bindTarget: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    if (bindTarget.startsWith("unix:")) {
      server.listen(bindTarget.slice("unix:".length), onListening);
    } else {
      const sepIndex = bindTarget.lastIndexOf(":");
      const host = bindTarget.slice(0, sepIndex);
      const port = Number(bindTarget.slice(sepIndex + 1));
      server.listen(port, host, onListening);
    }
  });
}

export async function startActivityGatewayServer(
  options: GatewayServerOptions,
): Promise<void> {
  const timeoutMs = options.defaultInvokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;

  const ensureQueueDeps = options.ensureQueueOnRegister?.deps;
  const onActorRegistered = ensureQueueDeps
    ? (actor: RegisteredActor) => {
      const key = actorKey(
        actor.parentFsmName,
        actor.parentFsmVersion,
        actor.asyncOperationType,
        actor.asyncOperationName,
        actor.asyncOperationVersion,
        actor.asyncOperationLanguage,
      );
      ensureAsyncOperationQueueForWorker(ensureQueueDeps, actor).then(
        (result) => {
          logger.info(
            "Ensured async-operation queue {queueName} for actor {actorKey} (alreadyExisted={alreadyExisted})",
            {
              queueName: result.queueName,
              actorKey: key,
              alreadyExisted: result.alreadyExisted,
            },
          );
        },
      ).catch((error) => {
        logger.error(
          "Failed to ensure async-operation queue for actor {actorKey}: {error}",
          { actorKey: key, error },
        );
      });
    }
    : undefined;

  const sidecar = new SidecarGateway({
    socketPath: options.sidecarSocketPath,
    onActorRegistered,
  });
  await sidecar.start();
  logger.info("Sidecar worker gateway listening on unix:{path}", {
    path: options.sidecarSocketPath,
  });

  if (options.asyncOpPollLoop) {
    startAsyncOpPollLoop(sidecar, options.asyncOpPollLoop.deps, {
      intervalMs: options.asyncOpPollLoop.intervalMs,
      invokeTimeoutMs: options.asyncOpPollLoop.invokeTimeoutMs,
      signal: options.signal,
    });
  }

  const serviceImpl: RawActivityGatewayServiceImpl = {
    invoke: async (req) => {
      logger.debug("Received Invoke() request: {request}", { request: req });
      try {
        const result = await sidecar.invoke(
          {
            parentFsmName: req.parentFsmName,
            parentFsmVersion: req.parentFsmVersion,
            asyncOperationType: req.asyncOperationType,
            asyncOperationName: req.asyncOperationName,
            asyncOperationVersion: req.asyncOperationVersion,
            asyncOperationLanguage: req.asyncOperationLanguage,
            input: parseInput(req.inputJson ?? ""),
            instanceId: req.instanceId,
            correlationId: req.correlationId,
          },
          req.timeoutMs > 0 ? req.timeoutMs : timeoutMs,
        );

        return {
          ok: true,
          outputJson: JSON.stringify(result.output ?? null),
          errorCode: "",
          errorMessage: "",
          retriable: false,
        };
      } catch (error) {
        const invokeError = error instanceof ActivityInvokeError
          ? error
          : new ActivityInvokeError(
            error instanceof Error ? error.message : String(error),
            "UNKNOWN",
          );

        return {
          ok: false,
          outputJson: "",
          errorCode: invokeError.code,
          errorMessage: invokeError.message,
          retriable: invokeError.retriable,
        };
      }
    },
    listRegisteredActors: () =>
      Promise.resolve({ actorKeys: sidecar.listRegisteredActors() }),
  };

  const routes = (router: ConnectRouter) => {
    router.service(
      ActivityGatewayService,
      serviceImpl as unknown as Partial<
        ServiceImpl<typeof ActivityGatewayService>
      >,
    );
  };

  cleanupUnixSocket(options.bindTarget);

  const server = http2.createServer(connectNodeAdapter({ routes }));
  await bindHttp2Server(server, options.bindTarget);
  logger.info("Activity gateway gRPC server listening on {target}", {
    target: options.bindTarget,
  });

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      logger.info("Activity gateway shutting down...");
      server.close(() => {
        sidecar.stop().then(() => {
          cleanupUnixSocket(options.bindTarget);
          resolve();
        });
      });
    };

    if (options.signal) {
      if (options.signal.aborted) {
        shutdown();
        return;
      }
      options.signal.addEventListener("abort", shutdown, { once: true });
    }
  });
}
