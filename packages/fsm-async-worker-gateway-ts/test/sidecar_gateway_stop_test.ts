// SidecarGateway.stop() with workers still connected (#397): it used to hang
// forever — the Session handler waited for the worker to end its request
// stream, while the worker waited for the response stream to end first.

import { assert, assertEquals, assertRejects } from "@std/assert";
import * as http2 from "node:http2";
import * as net from "node:net";
import {
  Register,
  RegisteredActor,
  SessionRequest,
} from "@pgfsm/proto-codegen/sidecargateway/v1/pb";
import { type ActorRegistration, ActorWorker } from "@pgfsm/async-worker-sdk";
import { ActivityInvokeError, SidecarGateway } from "../src/index.ts";

const IDENTITY = {
  parentFsmName: "creditCheck",
  parentFsmVersion: "v01",
  asyncOperationType: "internalAsyncOperation",
  asyncOperationVersion: "v01",
  asyncOperationLanguage: "typescript",
};

const INVOKE = {
  ...IDENTITY,
  input: {},
  instanceId: "instance-1",
  correlationId: "correlation-1",
};

async function waitFor(condition: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function timed<T>(promise: Promise<T>): Promise<number> {
  const started = Date.now();
  await promise;
  return Date.now() - started;
}

function worker(socketPath: string, registrations: ActorRegistration[]) {
  return new ActorWorker(
    {
      workerId: "stop-test",
      language: "typescript",
      gatewaySocketPath: socketPath,
      heartbeatMs: 50,
      reconnectInitialDelayMs: 10,
      reconnectMaxDelayMs: 50,
    },
    registrations,
  );
}

Deno.test({
  name: "stop() returns promptly with a worker connected, and it reconnects",
  // connect-node's HTTP/2 teardown finishes asynchronously.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir();
    const socketPath = `${dir}/sidecar.sock`;
    let gateway = new SidecarGateway({ socketPath });
    await gateway.start();
    const w = worker(socketPath, [
      { ...IDENTITY, asyncOperationName: "echo", handler: (input) => input },
    ]);
    const running = w.run();
    try {
      await waitFor(() => gateway.listRegisteredActors().length === 1);

      const elapsed = await timed(gateway.stop());
      assert(elapsed < 2_000, `stop() took ${elapsed}ms`);

      // The worker saw its session end and re-registers with a new gateway.
      gateway = new SidecarGateway({ socketPath });
      await gateway.start();
      await waitFor(() => gateway.listRegisteredActors().length === 1);
      const result = await gateway.invoke(
        { ...INVOKE, asyncOperationName: "echo", input: { n: 1 } },
        5_000,
      );
      assertEquals(result.output, { n: 1 });
    } finally {
      w.stop();
      await running;
      await gateway.stop();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "stop() fails in-flight invokes as WORKER_DISCONNECTED right away",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir();
    const socketPath = `${dir}/sidecar.sock`;
    // The worker is stuck in its handler, so it can't notice the stream
    // ending and close its side; stop() is bounded by the grace period.
    const gateway = new SidecarGateway({ socketPath, shutdownGraceMs: 300 });
    await gateway.start();
    let release = () => {};
    const w = worker(socketPath, [{
      ...IDENTITY,
      asyncOperationName: "slow",
      handler: () => new Promise((resolve) => (release = () => resolve(null))),
    }]);
    const running = w.run();
    try {
      await waitFor(() => gateway.listRegisteredActors().length === 1);
      const pending = gateway.invoke(
        { ...INVOKE, asyncOperationName: "slow" },
        60_000,
      );
      // Let the invoke reach the worker before stopping.
      await new Promise((resolve) => setTimeout(resolve, 100));

      const started = Date.now();
      const stopped = gateway.stop();
      const error = await assertRejects(() => pending, ActivityInvokeError);
      const rejectedAfter = Date.now() - started;
      const elapsed = await timed(stopped);
      assertEquals(error.code, "WORKER_DISCONNECTED");
      assertEquals(error.retriable, true);
      assert(rejectedAfter < 100, `invoke rejected after ${rejectedAfter}ms`);
      assert(elapsed < 2_000, `stop() took ${elapsed}ms`);
    } finally {
      release();
      w.stop();
      await running;
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "stop() destroys a connection whose client never ends its stream",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir();
    const socketPath = `${dir}/sidecar.sock`;
    const gateway = new SidecarGateway({ socketPath, shutdownGraceMs: 300 });
    await gateway.start();

    // A raw client that registers, then never half-closes its request stream
    // and ignores the response ending — the case graceful close alone can't
    // finish.
    const client = http2.connect("http://localhost", {
      createConnection: () => net.connect(socketPath),
    });
    const closed = new Promise<void>((resolve) => client.on("close", resolve));
    client.on("error", () => {});
    const stream = client.request({
      ":method": "POST",
      ":path": "/pgfsm.sidecargateway.v1.SidecarGatewayService/Session",
      "content-type": "application/grpc",
      te: "trailers",
    });
    stream.on("error", () => {});
    stream.resume();
    const message = new SessionRequest({
      payload: {
        case: "register",
        value: new Register({
          workerId: "raw",
          language: "typescript",
          protocolVersion: "1.0",
          actors: [
            new RegisteredActor({ ...IDENTITY, asyncOperationName: "raw" }),
          ],
        }),
      },
    }).toBinary();
    const frame = new Uint8Array(5 + message.length);
    new DataView(frame.buffer).setUint32(1, message.length);
    frame.set(message, 5);
    stream.write(frame);

    try {
      await waitFor(() => gateway.listRegisteredActors().length === 1);
      const elapsed = await timed(gateway.stop());
      assert(
        elapsed >= 250,
        `stop() returned after ${elapsed}ms, before grace`,
      );
      assert(elapsed < 2_000, `stop() took ${elapsed}ms`);
      await closed;
    } finally {
      client.destroy();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
