// SPEC-012 (b), #538: detecting that an in-flight invoke's state exited.
// DB-free parts: parsing a cancel notification, and one sweep against a fake
// database. LISTEN and the sweep against a real database are in
// cancel_detection_db_test.ts.

import { assertEquals } from "@std/assert";
import type { DBDeps } from "@pgfsm/db";
import {
  InvokeResult,
  Register,
  RegisteredActor,
  SessionRequest,
  type SessionResponse,
} from "@pgfsm/proto-codegen/sidecargateway/v1/pb";
import { parseCancelNotification, sweepOnce } from "../src/cancelDetection.ts";
import {
  type ActivityInvokeInput,
  CANCEL_REASON,
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
  asyncOperationLanguage: "typescript",
};
const INVOKE: ActivityInvokeInput = {
  ...ACTOR,
  input: {},
  instanceId: "instance-1",
  correlationId: "corr-1",
};
const QUEUE = "creditCheck_v01_i_checkBureau_t";

class PushStream<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private readonly waiting: Array<(result: IteratorResult<T>) => void> = [];
  push(item: T): void {
    const next = this.waiting.shift();
    if (next) next({ value: item, done: false });
    else this.buffered.push(item);
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> =>
        this.buffered.length > 0
          ? Promise.resolve({ value: this.buffered.shift()!, done: false })
          : new Promise((resolve) => this.waiting.push(resolve)),
    };
  }
}

/** A 2.0 worker on an in-memory session: records invokes and cancels. */
async function connectWorker(gateway: SidecarGateway) {
  const requests = new PushStream<SessionRequestMessage>();
  requests.push(
    new SessionRequest({
      payload: {
        case: "register",
        value: new Register({
          workerId: "w",
          language: "typescript",
          protocolVersion: "2.0",
          actors: [new RegisteredActor({ ...ACTOR, maxConcurrency: 4 })],
        }),
      },
    }),
  );
  const responses = (gateway as unknown as {
    handleSession(
      r: AsyncIterable<SessionRequestMessage>,
    ): AsyncIterable<SessionResponseMessage>;
  }).handleSession(requests)[Symbol.asyncIterator]();
  await responses.next(); // registerAck
  const invokes: string[] = [];
  const cancels: { invokeId: string; reason: number }[] = [];
  (async () => {
    while (true) {
      const { value, done } = await responses.next();
      if (done) return;
      if (value.payload.case === "invoke") {
        invokes.push(value.payload.value.invokeId);
      } else if (value.payload.case === "cancel") {
        cancels.push({
          invokeId: value.payload.value.invokeId,
          reason: value.payload.value.reason,
        });
      }
    }
  })();
  return {
    invokes,
    cancels,
    reply(invokeId: string) {
      requests.push(
        new SessionRequest({
          payload: {
            case: "invokeResult",
            value: new InvokeResult({ invokeId, outputJson: "{}" }),
          },
        }),
      );
    },
  };
}

/** A db whose sweep query reports `gone` as no longer queued. */
function fakeDeps(gone: { queue_name: string; msg_id: number }[]) {
  const queries: unknown[][] = [];
  const db = {
    query: (_text: string, values: unknown[]) => {
      queries.push(values);
      return Promise.resolve({ rows: [{ result: gone }] });
    },
  };
  return { deps: { db, useSupabase: false } as unknown as DBDeps, queries };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

Deno.test("parseCancelNotification reads {queue_name, msg_id} and rejects anything else", () => {
  assertEquals(
    parseCancelNotification(`{"queue_name": "${QUEUE}", "msg_id": 7}`),
    { queueName: QUEUE, msgId: 7 },
  );
  assertEquals(parseCancelNotification(undefined), null);
  assertEquals(parseCancelNotification("not json"), null);
  assertEquals(parseCancelNotification(`{"msg_id": 7}`), null);
  assertEquals(parseCancelNotification(`{"queue_name": "q"}`), null);
});

Deno.test("a sweep cancels the in-flight invokes whose messages are gone, and only those (#538)", async () => {
  const gateway = new SidecarGateway({ socketPath: "/unused" });
  const w = await connectWorker(gateway);
  const exited = gateway.invoke(INVOKE, 5_000, { queueName: QUEUE, msgId: 1 });
  exited.catch(() => {});
  const still = gateway.invoke(INVOKE, 5_000, { queueName: QUEUE, msgId: 2 });
  await tick();
  assertEquals(gateway.listPendingMessages().length, 2);

  const { deps, queries } = fakeDeps([{ queue_name: QUEUE, msg_id: 1 }]);
  assertEquals(await sweepOnce(gateway, deps), 1);
  await tick();
  assertEquals(queries.length, 1);
  assertEquals(w.cancels, [{
    invokeId: w.invokes[0],
    reason: CANCEL_REASON.STATE_EXITED,
  }]);
  // The cancelled one is no longer swept for; the other still is.
  assertEquals(gateway.listPendingMessages(), [{ queueName: QUEUE, msgId: 2 }]);

  w.reply(w.invokes[1]);
  await still;
  await gateway.stop();
});

Deno.test("a sweep with nothing in flight doesn't query the database (#538)", async () => {
  const gateway = new SidecarGateway({ socketPath: "/unused" });
  const { deps, queries } = fakeDeps([]);
  assertEquals(await sweepOnce(gateway, deps), 0);
  assertEquals(queries.length, 0);
});

Deno.test("a sweep naming another gateway's message cancels nothing here (#538)", async () => {
  const gateway = new SidecarGateway({ socketPath: "/unused" });
  const w = await connectWorker(gateway);
  const running = gateway.invoke(INVOKE, 5_000, { queueName: QUEUE, msgId: 3 });
  await tick();
  const { deps } = fakeDeps([{ queue_name: QUEUE, msg_id: 99 }]);
  assertEquals(await sweepOnce(gateway, deps), 0);
  assertEquals(w.cancels, []);
  w.reply(w.invokes[0]);
  await running;
  await gateway.stop();
});
