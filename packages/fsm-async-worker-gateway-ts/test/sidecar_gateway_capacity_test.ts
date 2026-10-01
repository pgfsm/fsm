// SPEC-007 routing in SidecarGateway: workers declare max_concurrency per
// actor, invokes go to the worker with the most free slots, the poll loop can
// see each actor's free slots, the per-actor routing snapshot tracks
// registration and invoke completion, and TCP sessions are authenticated and
// drained after their max connection age. Drives the private Session handler
// with in-memory streams, like sidecar_gateway_routing_test.ts.

import { assertEquals, assertRejects } from "@std/assert";
import {
  InvokeResult,
  Register,
  RegisteredActor,
  SessionRequest,
  type SessionResponse,
} from "@pgfsm/proto-codegen/sidecargateway/v1/pb";
import { createHandlerContext } from "@connectrpc/connect";
import { SidecarGatewayService } from "@pgfsm/proto-codegen/sidecargateway/v1/connect";
import {
  type ActivityInvokeInput,
  actorKey,
  SidecarGateway,
} from "../src/sidecar/gateway.ts";

type SessionRequestMessage = InstanceType<typeof SessionRequest>;
type SessionResponseMessage = InstanceType<typeof SessionResponse>;

const ACTOR = {
  parentFsmName: "creditCheck",
  parentFsmVersion: "v01",
  asyncOperationType: "internalAsyncOperation",
  asyncOperationName: "checkBureau",
  asyncOperationVersion: "v01",
  asyncOperationLanguage: "python",
};

const KEY = actorKey(
  ACTOR.parentFsmName,
  ACTOR.parentFsmVersion,
  ACTOR.asyncOperationType,
  ACTOR.asyncOperationName,
  ACTOR.asyncOperationVersion,
  ACTOR.asyncOperationLanguage,
);

const INVOKE: ActivityInvokeInput = {
  ...ACTOR,
  input: {},
  instanceId: "instance-1",
  correlationId: "corr-1",
};

class PushStream<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private readonly waiting: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    const next = this.waiting.shift();
    if (next) next({ value: item, done: false });
    else this.buffered.push(item);
  }

  close(): void {
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
    };
  }
}

interface FakeWorker {
  invokes: string[];
  reply(invokeId: string): void;
  close(): Promise<void>;
  /** Resolves when the gateway ends this worker's response stream. */
  ended: Promise<void>;
}

type HandleSession = (
  requests: AsyncIterable<SessionRequestMessage>,
  context?: unknown,
  policy?: { kind: "unix" | "tcp" },
) => AsyncIterable<SessionResponseMessage>;

function sessionContext(authorization?: string) {
  return createHandlerContext({
    service: SidecarGatewayService,
    method: SidecarGatewayService.methods.session,
    protocolName: "grpc",
    requestMethod: "POST",
    url:
      "http://localhost/pgfsm.sidecargateway.v1.SidecarGatewayService/Session",
    requestHeader: authorization ? { authorization } : {},
  });
}

async function connectWorker(
  gateway: SidecarGateway,
  workerId: string,
  maxConcurrency: number,
  options: { tcp?: boolean; authorization?: string } = {},
): Promise<FakeWorker> {
  const requests = new PushStream<SessionRequestMessage>();
  requests.push(
    new SessionRequest({
      payload: {
        case: "register",
        value: new Register({
          workerId,
          language: ACTOR.asyncOperationLanguage,
          protocolVersion: "1.0",
          actors: [new RegisteredActor({ ...ACTOR, maxConcurrency })],
        }),
      },
    }),
  );

  const handleSession = (gateway as unknown as { handleSession: HandleSession })
    .handleSession.bind(gateway);
  const responses = handleSession(
    requests,
    options.tcp ? sessionContext(options.authorization) : undefined,
    options.tcp ? { kind: "tcp" } : undefined,
  )[Symbol.asyncIterator]();

  const ack = await responses.next();
  assertEquals(ack.value?.payload.case, "registerAck");

  const invokes: string[] = [];
  const ended = (async () => {
    while (true) {
      const { value, done } = await responses.next();
      if (done) return;
      if (value.payload.case === "invoke") {
        invokes.push(value.payload.value.invokeId);
      }
    }
  })();

  return {
    invokes,
    ended,
    reply(invokeId) {
      requests.push(
        new SessionRequest({
          payload: {
            case: "invokeResult",
            value: new InvokeResult({
              invokeId,
              outputJson: JSON.stringify({ workerId }),
            }),
          },
        }),
      );
    },
    async close() {
      requests.close();
      await ended;
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function freeSlots(gateway: SidecarGateway): number | undefined {
  return gateway.listClaimableActors().find((a) =>
    actorKey(
      a.identity.parentFsmName,
      a.identity.parentFsmVersion,
      a.identity.asyncOperationType,
      a.identity.asyncOperationName,
      a.identity.asyncOperationVersion,
      a.identity.asyncOperationLanguage,
    ) === KEY
  )?.freeSlots;
}

Deno.test("invokes go to the worker with the most free slots, and free slots track them", async () => {
  const gateway = new SidecarGateway({ socketPath: "/unused" });
  const a = await connectWorker(gateway, "a", 2);
  const b = await connectWorker(gateway, "b", 1);
  assertEquals(freeSlots(gateway), 3);

  // a has 2 free, b 1: first to a; then a and b have 1 each (either);
  // the third goes to whichever is still free.
  const calls = [
    gateway.invoke(INVOKE, 1_000),
    gateway.invoke(INVOKE, 1_000),
    gateway.invoke(INVOKE, 1_000),
  ];
  await tick();
  assertEquals(a.invokes.length, 2);
  assertEquals(b.invokes.length, 1);
  assertEquals(freeSlots(gateway), 0);

  a.reply(a.invokes[0]);
  await calls[0];
  assertEquals(freeSlots(gateway), 1);

  a.reply(a.invokes[1]);
  b.reply(b.invokes[0]);
  await Promise.all(calls);
  assertEquals(freeSlots(gateway), 3);

  await a.close();
  await b.close();
});

Deno.test("max_concurrency 0 (an older SDK) counts as 1", async () => {
  const gateway = new SidecarGateway({ socketPath: "/unused" });
  const a = await connectWorker(gateway, "a", 0);
  assertEquals(freeSlots(gateway), 1);
  await a.close();
});

Deno.test("routing snapshot tracks registration, in-flight invokes and completion", async () => {
  const gateway = new SidecarGateway({ socketPath: "/unused" });
  assertEquals(gateway.routingSnapshot(), []);

  const a = await connectWorker(gateway, "a", 2);
  const b = await connectWorker(gateway, "b", 3);
  const [snapshot] = gateway.routingSnapshot();
  assertEquals(snapshot.actorKey, KEY);
  assertEquals(snapshot.identity, ACTOR);
  assertEquals(
    [snapshot.liveWorkers, snapshot.maxConcurrency, snapshot.inFlight],
    [2, 5, 0],
  );

  const call = gateway.invoke(INVOKE, 1_000);
  await tick();
  assertEquals(gateway.routingSnapshot()[0].inFlight, 1);

  const worker = a.invokes.length ? a : b;
  worker.reply(worker.invokes[0]);
  await call;
  assertEquals(gateway.routingSnapshot()[0].inFlight, 0);

  await a.close();
  assertEquals(
    [
      gateway.routingSnapshot()[0].liveWorkers,
      gateway.routingSnapshot()[0].maxConcurrency,
    ],
    [1, 3],
  );
  await b.close();
  assertEquals(gateway.routingSnapshot(), []);
});

Deno.test("a missing route is a retriable ACTOR_NOT_FOUND (#396)", async () => {
  const gateway = new SidecarGateway({ socketPath: "/unused" });
  const error = await assertRejects(() => gateway.invoke(INVOKE, 1_000));
  assertEquals(
    [
      (error as { code: string }).code,
      (error as { retriable: boolean }).retriable,
    ],
    ["ACTOR_NOT_FOUND", true],
  );
});

Deno.test("TCP sessions need the bearer token, re-read from its file each time", async () => {
  const tokenFile = await Deno.makeTempFile();
  await Deno.writeTextFile(tokenFile, "first-token\n");
  const gateway = new SidecarGateway({
    socketPath: "/unused",
    authTokenFile: tokenFile,
    maxConnectionAgeMs: 0,
  });
  try {
    for (const authorization of [undefined, "Bearer wrong", "first-token"]) {
      await assertRejects(
        () => connectWorker(gateway, "x", 1, { tcp: true, authorization }),
        Error,
        "missing or invalid bearer token",
      );
    }
    const ok = await connectWorker(gateway, "a", 1, {
      tcp: true,
      authorization: "Bearer first-token",
    });
    await ok.close();

    // Rotation: the new token works and the old one doesn't, no restart.
    await Deno.writeTextFile(tokenFile, "second-token");
    await assertRejects(
      () =>
        connectWorker(gateway, "b", 1, {
          tcp: true,
          authorization: "Bearer first-token",
        }),
      Error,
      "missing or invalid bearer token",
    );
    const rotated = await connectWorker(gateway, "b", 1, {
      tcp: true,
      authorization: "Bearer second-token",
    });
    await rotated.close();

    // Unix-socket sessions aren't checked.
    const unix = await connectWorker(gateway, "c", 1);
    await unix.close();
  } finally {
    await Deno.remove(tokenFile);
  }
});

Deno.test("a TCP worker past its max connection age is drained, then disconnected", async () => {
  const gateway = new SidecarGateway({
    socketPath: "/unused",
    maxConnectionAgeMs: 50,
    connectionDrainGraceMs: 5_000,
  });
  const a = await connectWorker(gateway, "a", 2, { tcp: true });
  const inFlight = gateway.invoke(INVOKE, 5_000);
  await tick();
  assertEquals(a.invokes.length, 1);

  await sleep(80); // past 50 ms ± 10 %
  // Draining: no capacity, no new invokes, but still connected.
  assertEquals(freeSlots(gateway), 0);
  await assertRejects(
    () => gateway.invoke(INVOKE, 1_000),
    Error,
    "worker unavailable",
  );
  assertEquals(gateway.routingSnapshot()[0].liveWorkers, 1);

  // The in-flight invoke finishes, then the gateway ends the stream.
  a.reply(a.invokes[0]);
  await inFlight;
  await a.ended;
  assertEquals(gateway.listRegisteredActors(), []);
});

Deno.test("Unix-socket workers never hit the max connection age", async () => {
  const gateway = new SidecarGateway({
    socketPath: "/unused",
    maxConnectionAgeMs: 20,
  });
  const a = await connectWorker(gateway, "a", 1);
  await sleep(60);
  assertEquals(freeSlots(gateway), 1);
  await a.close();
});
