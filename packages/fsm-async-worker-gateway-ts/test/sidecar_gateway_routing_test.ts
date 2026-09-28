// Multi-worker routing in SidecarGateway (#391): several workers may register
// the same actor, invokes are spread across them, and one worker leaving
// never drops a route another worker still serves. Drives the private
// Session handler directly with in-memory streams — no socket needed.

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
  asyncOperationName: "checkReportsTable",
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
  /** invokeIds this worker has received, in arrival order. */
  invokes: string[];
  /** Replies to a received invoke with an InvokeResult tagged by worker. */
  reply(invokeId: string): void;
  /** Ends the stream, as a worker process exiting would. */
  close(): Promise<void>;
}

async function connectWorker(
  gateway: SidecarGateway,
  workerId: string,
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
          actors: [new RegisteredActor(ACTOR)],
        }),
      },
    }),
  );

  // handleSession is private; tests reach it the same way the Connect router
  // does — as the Session method implementation.
  const responses = (gateway as unknown as {
    handleSession(
      requests: AsyncIterable<SessionRequestMessage>,
    ): AsyncIterable<SessionResponseMessage>;
  }).handleSession(requests)[Symbol.asyncIterator]();

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

/** Lets pushed invokes reach the fake workers' drain loops. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

Deno.test("two workers on one actor both receive invokes", async () => {
  const gateway = new SidecarGateway({ socketPath: "/unused" });
  const a = await connectWorker(gateway, "a");
  const b = await connectWorker(gateway, "b");

  const first = gateway.invoke(INVOKE, 1_000);
  const second = gateway.invoke(INVOKE, 1_000);
  await tick();

  // Least-in-flight: the second invoke goes to whichever worker is idle.
  assertEquals(a.invokes.length, 1);
  assertEquals(b.invokes.length, 1);

  a.reply(a.invokes[0]);
  b.reply(b.invokes[0]);
  const outputs = [(await first).output, (await second).output];
  assertEquals(
    outputs.map((o) => (o as { workerId: string }).workerId).sort(),
    ["a", "b"],
  );

  assertEquals(gateway.listRegisteredActors(), [KEY]);
  assertEquals(gateway.listRegisteredActorIdentities().length, 1);

  await a.close();
  await b.close();
});

Deno.test("worker leaving keeps a route another worker registered later", async () => {
  const gateway = new SidecarGateway({ socketPath: "/unused" });
  const a = await connectWorker(gateway, "a");
  const b = await connectWorker(gateway, "b");

  await a.close();
  assertEquals(gateway.listRegisteredActors(), [KEY]);

  const pending = gateway.invoke(INVOKE, 1_000);
  await tick();
  assertEquals(a.invokes.length, 0);
  assertEquals(b.invokes.length, 1);
  b.reply(b.invokes[0]);
  assertEquals((await pending).output, { workerId: "b" });

  await b.close();
  assertEquals(gateway.listRegisteredActors(), []);
  await assertRejects(
    () => gateway.invoke(INVOKE, 1_000),
    Error,
    "no worker registered",
  );
});

Deno.test("stale session closing doesn't drop the same workerId's re-registration", async () => {
  const gateway = new SidecarGateway({ socketPath: "/unused" });
  const oldSession = await connectWorker(gateway, "a");
  const newSession = await connectWorker(gateway, "a");

  await oldSession.close();
  assertEquals(gateway.listRegisteredActors(), [KEY]);

  const pending = gateway.invoke(INVOKE, 1_000);
  await tick();
  assertEquals(newSession.invokes.length, 1);
  newSession.reply(newSession.invokes[0]);
  assertEquals((await pending).output, { workerId: "a" });

  await newSession.close();
});
