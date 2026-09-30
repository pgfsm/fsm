// SPEC-007 routing in SidecarGateway: workers declare max_concurrency per
// actor, invokes go to the worker with the most free slots, the poll loop can
// see each actor's free slots, and the per-actor routing snapshot tracks
// registration and invoke completion. Drives the private Session handler with
// in-memory streams, like sidecar_gateway_routing_test.ts.

import { assertEquals, assertRejects } from "@std/assert";
import {
  InvokeResult,
  Register,
  RegisteredActor,
  SessionRequest,
  type SessionResponse,
} from "@pgfsm/proto-codegen/sidecargateway/v1/pb";
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
}

type HandleSession = (
  requests: AsyncIterable<SessionRequestMessage>,
) => AsyncIterable<SessionResponseMessage>;

async function connectWorker(
  gateway: SidecarGateway,
  workerId: string,
  maxConcurrency: number,
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
  const responses = handleSession(requests)[Symbol.asyncIterator]();

  const ack = await responses.next();
  assertEquals(ack.value?.payload.case, "registerAck");

  const invokes: string[] = [];
  const drained = (async () => {
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
      await drained;
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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
