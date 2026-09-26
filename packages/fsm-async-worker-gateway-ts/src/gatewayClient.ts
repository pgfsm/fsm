// Thin gRPC client for the Activity Gateway. Intended caller: the
// "rust"/"go" branch of startAsyncOperationWorkerForLang in
// asyncOperationWorkerlet.ts, once that wiring is implemented per SPEC-001 —
// this file is base scaffolding, not yet integrated there.
//
// The orchestrator keeps owning PGMQ poll/claim/archive; this client is only
// the invocation leg, one call per claimed message.
//
// Built on the compiler-generated Connect-ES stubs (imported as
// @pgfsm/proto-codegen, a Deno workspace-linked package, not published —
// see #103) instead of @grpc/proto-loader's runtime reflection — real generated types,
// no schema loaded off disk at startup. gatewayServer.ts made the same move
// server-side, via connectNodeAdapter. connect-node's transport speaks
// HTTP/2 over a URL authority, with no native "unix:" scheme the way
// grpc-js's channel target syntax has, so a "unix:<path>" target is
// translated into an HTTP/2 session with a custom `createConnection` that
// dials the socket directly instead (verified this round-trips real
// Invoke/ListRegisteredActors calls against gatewayServer.ts over a real
// Unix socket).

import { createClient } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import * as net from "node:net";
import type { ClientSessionOptions } from "node:http2";
import { ActivityGatewayService } from "@pgfsm/proto-codegen/activitygateway/v1/connect";

// Connect's `Client<typeof ActivityGatewayService>` utility type resolves every
// method to `never` under `deno check` specifically (reproduced in complete
// isolation outside this workspace/repo — a plain `tsc` with the same
// package versions infers it correctly, so this is a Deno type-checker gap,
// not a config mistake). Sidestepped the same way the old @grpc/proto-loader
// version of this class already did for grpc-js's untyped client: hand-roll
// the exact shape actually called and cast once at construction, instead of
// fighting Connect's generic inference under Deno.
interface RawActivityGatewayClient {
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

export interface ActivityGatewayClientOptions {
  /** e.g. "unix:/tmp/pgfsm-activity-gateway.sock" or "127.0.0.1:50061" */
  target: string;
}

export interface InvokeActorRequest {
  parentFsmName: string;
  parentFsmVersion: string;
  asyncOperationType: string;
  asyncOperationName: string;
  asyncOperationVersion: string;
  asyncOperationLanguage: string;
  input: unknown;
  instanceId: string;
  correlationId: string;
  timeoutMs: number;
}

export interface InvokeActorResult {
  output: unknown;
}

export class ActivityGatewayInvokeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retriable: boolean,
  ) {
    super(message);
    this.name = "ActivityGatewayInvokeError";
  }
}

/**
 * Translates a grpc-js-style channel target ("unix:<path>" or "host:port")
 * into connect-node's shape: a placeholder `baseUrl` (Connect always needs
 * one, but it's irrelevant once `createConnection` is set — the socket
 * path, not the URL, decides where bytes actually go) plus a `createConnection`
 * override for unix sockets. TCP targets need no override; connect-node's
 * default net.connect(host, port) is already the standard path.
 */
function targetToHttp2Options(
  target: string,
): { baseUrl: string; http2Options?: ClientSessionOptions } {
  if (target.startsWith("unix:")) {
    const socketPath = target.slice("unix:".length);
    return {
      baseUrl: "http://localhost",
      http2Options: { createConnection: () => net.connect(socketPath) },
    };
  }
  return { baseUrl: `http://${target}` };
}

export class ActivityGatewayClient {
  private readonly client: RawActivityGatewayClient;
  private readonly sessionManager: Http2SessionManager;

  constructor(options: ActivityGatewayClientOptions) {
    const { baseUrl, http2Options } = targetToHttp2Options(options.target);
    this.sessionManager = new Http2SessionManager(
      baseUrl,
      undefined,
      http2Options,
    );
    const transport = createGrpcTransport({
      baseUrl,
      httpVersion: "2",
      sessionManager: this.sessionManager,
    });
    this.client = createClient(
      ActivityGatewayService,
      transport,
    ) as unknown as RawActivityGatewayClient;
  }

  async invokeActor(request: InvokeActorRequest): Promise<InvokeActorResult> {
    const response = await this.client.invoke({
      parentFsmName: request.parentFsmName,
      parentFsmVersion: request.parentFsmVersion,
      asyncOperationType: request.asyncOperationType,
      asyncOperationName: request.asyncOperationName,
      asyncOperationVersion: request.asyncOperationVersion,
      asyncOperationLanguage: request.asyncOperationLanguage,
      inputJson: JSON.stringify(request.input ?? null),
      instanceId: request.instanceId,
      correlationId: request.correlationId,
      timeoutMs: request.timeoutMs,
    });
    if (!response.ok) {
      throw new ActivityGatewayInvokeError(
        response.errorMessage || "activity gateway invoke failed",
        response.errorCode || "UNKNOWN",
        response.retriable,
      );
    }
    return { output: JSON.parse(response.outputJson || "null") };
  }

  async listRegisteredActors(): Promise<string[]> {
    const response = await this.client.listRegisteredActors({});
    return response.actorKeys;
  }

  close(): void {
    this.sessionManager.abort();
  }
}
