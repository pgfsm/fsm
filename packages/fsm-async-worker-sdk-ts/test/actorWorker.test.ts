// End-to-end: a real in-process SidecarGateway (fsm-async-worker-gateway-ts —
// it never opens a database connection) on a temp Unix socket, with this
// package's ActorWorker registering against it and serving invokes over the
// generated gRPC stream. @pgfsm/async-worker-gateway is a test-only workspace import;
// the published package never depends on it.

import { assertEquals, assertRejects } from "@std/assert";
import {
  ActivityInvokeError,
  SidecarGateway,
} from "@pgfsm/async-worker-gateway";
import { type ActorRegistration, ActorWorker } from "../src/index.ts";

const IDENTITY = {
  parentFsmName: "creditCheck",
  parentFsmVersion: "v01",
  asyncOperationType: "fsm",
  asyncOperationLanguage: "typescript",
};

const REGISTRATIONS: ActorRegistration[] = [
  {
    ...IDENTITY,
    asyncOperationName: "double",
    asyncOperationVersion: "v01",
    handler: (input) => ({ doubled: (input as { n: number }).n * 2 }),
  },
  {
    ...IDENTITY,
    asyncOperationName: "fail",
    asyncOperationVersion: "v01",
    handler: () => {
      throw new Error("boom");
    },
  },
];

async function waitFor(
  condition: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

Deno.test({
  name: "ActorWorker - registers with a real SidecarGateway and serves invokes",
  // connect-node's HTTP/2 session teardown finishes asynchronously after
  // stop() returns; the behaviour under test is the invoke round-trip.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir();
    const socketPath = `${dir}/sidecar.sock`;
    const gateway = new SidecarGateway({ socketPath });
    await gateway.start();
    const worker = new ActorWorker(
      {
        workerId: "test-worker",
        language: "typescript",
        gatewaySocketPath: socketPath,
        // run() only returns after the heartbeat loop's current sleep ends.
        heartbeatMs: 50,
      },
      REGISTRATIONS,
    );
    const running = worker.run();
    try {
      await waitFor(() => gateway.listRegisteredActors().length === 2);
      assertEquals(gateway.listRegisteredActors(), [
        "creditCheck@v01@fsm@double@v01@typescript",
        "creditCheck@v01@fsm@fail@v01@typescript",
      ]);

      const result = await gateway.invoke({
        ...IDENTITY,
        asyncOperationName: "double",
        asyncOperationVersion: "v01",
        input: { n: 21 },
        instanceId: "instance-1",
        correlationId: "correlation-1",
      }, 5_000);
      assertEquals(result.output, { doubled: 42 });

      const error = await assertRejects(
        () =>
          gateway.invoke({
            ...IDENTITY,
            asyncOperationName: "fail",
            asyncOperationVersion: "v01",
            input: null,
            instanceId: "instance-2",
            correlationId: "correlation-2",
          }, 5_000),
        ActivityInvokeError,
      );
      assertEquals(error.code, "INTERNAL");
      assertEquals(error.message, "boom");
    } finally {
      worker.stop();
      await running;
      await gateway.stop();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("ActorWorker - refuses to start with an empty registry", async () => {
  const worker = new ActorWorker(
    {
      workerId: "empty",
      language: "typescript",
      gatewaySocketPath: "/nonexistent.sock",
    },
    [],
  );
  await assertRejects(
    () => worker.run(),
    Error,
    "no actors to register, refusing to start worker",
  );
});
