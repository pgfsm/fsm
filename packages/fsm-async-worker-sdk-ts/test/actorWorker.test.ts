// End-to-end: a real in-process SidecarGateway (fsm-async-worker-gateway-ts —
// it never opens a database connection) on a temp Unix socket, with this
// package's ActorWorker registering against it and serving invokes over the
// generated gRPC stream. @pgfsm/async-worker-gateway is a test-only workspace import;
// the published package never depends on it.

import { assertEquals, assertRejects } from "@std/assert";
import * as http2 from "node:http2";
import {
  Code,
  ConnectError,
  type ConnectRouter,
  type ServiceImpl,
} from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { SidecarGatewayService } from "@pgfsm/proto-codegen/sidecargateway/v1/connect";
import {
  RegisterAck,
  type SessionRequest,
  SessionResponse,
} from "@pgfsm/proto-codegen/sidecargateway/v1/pb";
import {
  ActivityInvokeError,
  SidecarGateway,
} from "@pgfsm/async-worker-gateway";
import {
  type ActorRegistration,
  ActorWorker,
  reconnectDelayMs,
} from "../src/index.ts";

type SessionRequestMessage = InstanceType<typeof SessionRequest>;
type SessionResponseMessage = InstanceType<typeof SessionResponse>;

/**
 * A bare sidecar server with a hand-written Session handler, for gateway
 * behaviours the real SidecarGateway doesn't produce (auth errors, flapping).
 */
async function serveSession(
  socketPath: string,
  session: (
    requests: AsyncIterable<SessionRequestMessage>,
  ) => AsyncIterable<SessionResponseMessage>,
): Promise<http2.Http2Server> {
  const server = http2.createServer(
    connectNodeAdapter({
      routes: (router: ConnectRouter) => {
        router.service(
          SidecarGatewayService,
          { session } as unknown as Partial<
            ServiceImpl<typeof SidecarGatewayService>
          >,
        );
      },
    }),
  );
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return server;
}

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

// Reconnect (#392): the worker waits for a gateway that isn't up yet,
// re-registers after the gateway restarts, and only gives up when told to.

const FAST_RECONNECT = {
  heartbeatMs: 50,
  reconnectInitialDelayMs: 10,
  reconnectMaxDelayMs: 50,
};

const DOUBLE_INVOKE = {
  ...IDENTITY,
  asyncOperationName: "double",
  asyncOperationVersion: "v01",
  input: { n: 4 },
  instanceId: "instance-r",
  correlationId: "correlation-r",
};

Deno.test({
  name: "ActorWorker - waits for a gateway that starts after it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir();
    const socketPath = `${dir}/sidecar.sock`;
    const worker = new ActorWorker(
      {
        workerId: "early-worker",
        language: "typescript",
        gatewaySocketPath: socketPath,
        ...FAST_RECONNECT,
      },
      REGISTRATIONS,
    );
    const running = worker.run();
    // Let a few connection attempts fail against the missing socket.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const gateway = new SidecarGateway({ socketPath });
    await gateway.start();
    try {
      await waitFor(() => gateway.listRegisteredActors().length === 2);
      const result = await gateway.invoke(DOUBLE_INVOKE, 5_000);
      assertEquals(result.output, { doubled: 8 });
    } finally {
      worker.stop();
      await running;
      await gateway.stop();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

async function* readLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  let buffered = "";
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      yield buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
    }
  }
}

/** Resolves once the gateway process prints a line matching `predicate`. */
async function waitForLine(
  lines: AsyncIterator<string>,
  predicate: (line: string) => boolean,
): Promise<void> {
  while (true) {
    const { value, done } = await lines.next();
    if (done) throw new Error("gateway process exited early");
    if (predicate(value)) return;
  }
}

Deno.test({
  name: "ActorWorker - re-registers after the gateway crashes and restarts",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir();
    const socketPath = `${dir}/sidecar.sock`;

    // First gateway runs in a child process so it can be SIGKILLed — a real
    // crash, with the worker's connection reset rather than closed cleanly.
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        new URL("./fixtures/run_gateway.ts", import.meta.url).pathname,
        socketPath,
      ],
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const lines = readLines(child.stdout);
    await waitForLine(lines, (line) => line === "ready");

    const worker = new ActorWorker(
      {
        workerId: "restart-worker",
        language: "typescript",
        gatewaySocketPath: socketPath,
        ...FAST_RECONNECT,
      },
      REGISTRATIONS,
    );
    const running = worker.run();
    let gateway: SidecarGateway | null = null;
    try {
      await waitForLine(lines, (line) => line === "registered double");
      child.kill("SIGKILL");
      await child.status;

      gateway = new SidecarGateway({ socketPath });
      await gateway.start();

      await waitFor(() => gateway!.listRegisteredActors().length === 2);
      const result = await gateway.invoke(DOUBLE_INVOKE, 5_000);
      assertEquals(result.output, { doubled: 8 });
    } finally {
      worker.stop();
      await running;
      await gateway?.stop();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "ActorWorker - gives up after reconnectMaxAttempts failed attempts",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const worker = new ActorWorker(
      {
        workerId: "no-gateway",
        language: "typescript",
        gatewaySocketPath: "/nonexistent/sidecar.sock",
        ...FAST_RECONNECT,
        reconnectMaxAttempts: 3,
      },
      REGISTRATIONS,
    );
    await assertRejects(
      () => worker.run(),
      Error,
      "giving up after 3 consecutive failed attempt(s)",
    );
  },
});

Deno.test({
  name: "ActorWorker - stop() interrupts the reconnect backoff",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const worker = new ActorWorker(
      {
        workerId: "stop-in-backoff",
        language: "typescript",
        gatewaySocketPath: "/nonexistent/sidecar.sock",
        reconnectInitialDelayMs: 60_000,
        reconnectMaxDelayMs: 60_000,
      },
      REGISTRATIONS,
    );
    const running = worker.run();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    worker.stop();
    await running;
    assertEquals(Date.now() - started < 1_000, true);
  },
});

Deno.test({
  name: "ActorWorker - fails fast on UNAUTHENTICATED instead of retrying",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir();
    const socketPath = `${dir}/sidecar.sock`;
    let sessions = 0;
    const server = await serveSession(socketPath, async function* () {
      sessions++;
      throw new ConnectError("bad token", Code.Unauthenticated);
    });
    try {
      const worker = new ActorWorker(
        {
          workerId: "unauthenticated",
          language: "typescript",
          gatewaySocketPath: socketPath,
          ...FAST_RECONNECT,
        },
        REGISTRATIONS,
      );
      const error = await assertRejects(() => worker.run(), ConnectError);
      assertEquals(error.code, Code.Unauthenticated);
      assertEquals(sessions, 1);
    } finally {
      server.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "ActorWorker - a flapping gateway counts toward reconnectMaxAttempts",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir();
    const socketPath = `${dir}/sidecar.sock`;
    let registrations = 0;
    // Acks every registration, then immediately ends the session.
    const server = await serveSession(socketPath, async function* (requests) {
      for await (const _ of requests) {
        registrations++;
        yield new SessionResponse({
          payload: {
            case: "registerAck",
            value: new RegisterAck({ accepted: true }),
          },
        });
        return;
      }
    });
    try {
      const worker = new ActorWorker(
        {
          workerId: "flapping",
          language: "typescript",
          gatewaySocketPath: socketPath,
          ...FAST_RECONNECT,
          reconnectMaxAttempts: 3,
        },
        REGISTRATIONS,
      );
      await assertRejects(
        () => worker.run(),
        Error,
        "giving up after 3 consecutive failed attempt(s)",
      );
      assertEquals(registrations, 3);
    } finally {
      server.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("reconnectDelayMs - full jitter under the capped exponential", () => {
  for (let attempt = 1; attempt <= 12; attempt++) {
    const ceiling = Math.min(30_000, 250 * 2 ** (attempt - 1));
    for (let i = 0; i < 50; i++) {
      const delay = reconnectDelayMs(attempt, 250, 30_000);
      assertEquals(delay >= 0 && delay < ceiling, true);
    }
  }
});
