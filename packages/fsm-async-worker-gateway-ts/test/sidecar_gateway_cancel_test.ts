// SPEC-012 (a), #537: the gateway's side of cancelling an in-flight invoke.
// Sidecar protocol 2.0 (1.x workers are rejected), Cancel{reason} on an
// invoke timeout, on stop() and at a drain deadline, cancelling by queue
// message, and a cancelled invoke's slot held until the worker replies, whose
// reply is then dropped. Drives the private Session handler with in-memory
// streams, like sidecar_gateway_capacity_test.ts.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  CancelReason,
  InvokeError,
  InvokeErrorDetail,
  InvokeResult,
  Register,
  RegisteredActor,
  SessionRequest,
  type SessionResponse,
} from "@pgfsm/proto-codegen/sidecargateway/v1/pb";
import {
  ActivityInvokeError,
  type ActivityInvokeInput,
  actorKey,
  CANCEL_REASON,
  type CancelAcknowledgement,
  isSupportedProtocolVersion,
  SidecarGateway,
  type SidecarGatewayOptions,
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

const MESSAGE = { queueName: "creditCheck_v01_i_checkBureau_t", msgId: 7 };

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

type HandleSession = (
  requests: AsyncIterable<SessionRequestMessage>,
  context?: unknown,
  policy?: { kind: "unix" | "tcp" },
) => AsyncIterable<SessionResponseMessage>;

interface FakeWorker {
  ack: SessionResponseMessage | undefined;
  invokes: string[];
  cancels: { invokeId: string; reason: number }[];
  /** Everything the gateway pushed after the ack, in order. */
  pushed: string[];
  reply(invokeId: string): void;
  replyCancelled(invokeId: string): void;
  /** Resolves when the gateway ends this worker's response stream. */
  ended: Promise<void>;
}

async function connectWorker(
  gateway: SidecarGateway,
  options: { protocolVersion?: string; tcp?: boolean } = {},
): Promise<FakeWorker> {
  const requests = new PushStream<SessionRequestMessage>();
  requests.push(
    new SessionRequest({
      payload: {
        case: "register",
        value: new Register({
          workerId: "w",
          language: ACTOR.asyncOperationLanguage,
          protocolVersion: options.protocolVersion ?? "2.0",
          actors: [new RegisteredActor({ ...ACTOR, maxConcurrency: 1 })],
        }),
      },
    }),
  );
  const handleSession = (gateway as unknown as { handleSession: HandleSession })
    .handleSession.bind(gateway);
  const responses = handleSession(
    requests,
    undefined,
    options.tcp ? { kind: "tcp" } : undefined,
  )[Symbol.asyncIterator]();

  const first = await responses.next();
  const worker: FakeWorker = {
    ack: first.value,
    invokes: [],
    cancels: [],
    pushed: [],
    reply(invokeId) {
      requests.push(
        new SessionRequest({
          payload: {
            case: "invokeResult",
            value: new InvokeResult({ invokeId, outputJson: "{}" }),
          },
        }),
      );
    },
    replyCancelled(invokeId) {
      requests.push(
        new SessionRequest({
          payload: {
            case: "invokeError",
            value: new InvokeError({
              invokeId,
              error: new InvokeErrorDetail({
                code: "CANCELLED",
                message: "handler stopped",
                retriable: false,
              }),
            }),
          },
        }),
      );
    },
    ended: Promise.resolve(),
  };
  worker.ended = (async () => {
    if (first.done) return;
    while (true) {
      const { value, done } = await responses.next();
      if (done) return;
      worker.pushed.push(value.payload.case ?? "");
      if (value.payload.case === "invoke") {
        worker.invokes.push(value.payload.value.invokeId);
      } else if (value.payload.case === "cancel") {
        worker.cancels.push({
          invokeId: value.payload.value.invokeId,
          reason: value.payload.value.reason,
        });
      }
    }
  })();
  return worker;
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

function newGateway(options: Partial<SidecarGatewayOptions> = {}) {
  const acks: CancelAcknowledgement[] = [];
  const gateway = new SidecarGateway({
    socketPath: "/unused",
    onCancelAcknowledged: (ack) => acks.push(ack),
    ...options,
  });
  return { gateway, acks };
}

Deno.test("CANCEL_REASON matches the generated CancelReason enum", () => {
  assertEquals(CANCEL_REASON.UNSPECIFIED, CancelReason.UNSPECIFIED);
  assertEquals(CANCEL_REASON.STATE_EXITED, CancelReason.STATE_EXITED);
  assertEquals(CANCEL_REASON.TIMEOUT, CancelReason.TIMEOUT);
  assertEquals(CANCEL_REASON.SHUTDOWN, CancelReason.SHUTDOWN);
});

Deno.test("only sidecar protocol 2.x is accepted", () => {
  assert(isSupportedProtocolVersion("2.0"));
  assert(isSupportedProtocolVersion("2.1"));
  assert(!isSupportedProtocolVersion("1.0"));
  assert(!isSupportedProtocolVersion(""));
  assert(!isSupportedProtocolVersion("3.0"));
});

Deno.test("a worker registering with protocol 1.0 is rejected and its stream ended (#537)", async () => {
  const { gateway } = newGateway();
  const w = await connectWorker(gateway, { protocolVersion: "1.0" });
  assertEquals(w.ack?.payload.case, "registerAck");
  const ack = w.ack?.payload.value as {
    accepted: boolean;
    gatewayProtocolVersion: string;
    rejectedActors: string[];
  };
  assertEquals(ack.accepted, false);
  assertEquals(ack.gatewayProtocolVersion, "2.0");
  assertEquals(ack.rejectedActors, [KEY]);
  await w.ended;
  assertEquals(gateway.listRegisteredActors(), []);
});

Deno.test("a 2.0 worker is accepted, and the gateway reports 2.0", async () => {
  const { gateway } = newGateway();
  const w = await connectWorker(gateway);
  const ack = w.ack?.payload.value as {
    accepted: boolean;
    gatewayProtocolVersion: string;
  };
  assertEquals(ack.accepted, true);
  assertEquals(ack.gatewayProtocolVersion, "2.0");
  assertEquals(gateway.listRegisteredActors(), [KEY]);
  await gateway.stop();
});

Deno.test("an invoke timeout sends Cancel{TIMEOUT}, rejects retriably, and holds the slot until the reply (#537)", async () => {
  const { gateway, acks } = newGateway();
  const w = await connectWorker(gateway);
  const invoked = gateway.invoke(INVOKE, 50, MESSAGE);
  await tick();
  const [invokeId] = w.invokes;

  const error = await assertRejects(() => invoked, ActivityInvokeError);
  assertEquals(error.code, "TIMEOUT");
  assertEquals(error.retriable, true);
  await tick();
  assertEquals(w.cancels, [{ invokeId, reason: CANCEL_REASON.TIMEOUT }]);
  // Still running on the worker: no free slot.
  assertEquals(freeSlots(gateway), 0);

  // The handler finished anyway: the reply frees the slot and is dropped.
  w.reply(invokeId);
  await sleep(10);
  assertEquals(freeSlots(gateway), 1);
  assertEquals(acks.map((a) => [a.reason, a.outcome]), [
    [CANCEL_REASON.TIMEOUT, "completed"],
  ]);
  assertEquals(acks[0].message, MESSAGE);
  await gateway.stop();
});

Deno.test("cancelByMessage sends Cancel{STATE_EXITED} and rejects with a non-retriable CANCELLED (#537)", async () => {
  const { gateway, acks } = newGateway();
  const w = await connectWorker(gateway);
  const invoked = gateway.invoke(INVOKE, 5_000, MESSAGE);
  await tick();
  const [invokeId] = w.invokes;

  // Another gateway's message, or another message: nothing to cancel.
  assertEquals(
    gateway.cancelByMessage({ queueName: MESSAGE.queueName, msgId: 8 }),
    0,
  );
  assertEquals(gateway.cancelByMessage(MESSAGE), 1);
  const error = await assertRejects(() => invoked, ActivityInvokeError);
  assertEquals(error.code, "CANCELLED");
  assertEquals(error.retriable, false);
  await tick();
  assertEquals(w.cancels, [{ invokeId, reason: CANCEL_REASON.STATE_EXITED }]);
  // A second cancel of the same message sends nothing more.
  assertEquals(gateway.cancelByMessage(MESSAGE), 0);
  assertEquals(freeSlots(gateway), 0);

  // The handler stopped: InvokeError CANCELLED acknowledges it.
  w.replyCancelled(invokeId);
  await sleep(10);
  assertEquals(freeSlots(gateway), 1);
  assertEquals(acks.map((a) => [a.reason, a.outcome]), [
    [CANCEL_REASON.STATE_EXITED, "aborted"],
  ]);
  // Once replied to, the message is no longer indexed.
  assertEquals(gateway.cancelByMessage(MESSAGE), 0);
  await gateway.stop();
});

Deno.test("without a reply the cancelled invoke's slot stays held past the grace (#537)", async () => {
  const { gateway } = newGateway({ cancelAckGraceMs: 20 });
  await connectWorker(gateway);
  const invoked = gateway.invoke(INVOKE, 5_000, MESSAGE);
  await tick();
  gateway.cancelByMessage(MESSAGE);
  await assertRejects(() => invoked, ActivityInvokeError);
  await sleep(60);
  assertEquals(freeSlots(gateway), 0, "the warning doesn't free the slot");
  await gateway.stop();
});

Deno.test("stop() sends Cancel{SHUTDOWN} for running invokes before ending the stream (#537)", async () => {
  const { gateway } = newGateway();
  const w = await connectWorker(gateway);
  const invoked = gateway.invoke(INVOKE, 5_000, MESSAGE);
  await tick();
  const [invokeId] = w.invokes;

  await gateway.stop();
  const error = await assertRejects(() => invoked, ActivityInvokeError);
  assertEquals(error.code, "WORKER_DISCONNECTED");
  assertEquals(error.retriable, true);
  await w.ended;
  assertEquals(w.cancels, [{ invokeId, reason: CANCEL_REASON.SHUTDOWN }]);
  assertEquals(w.pushed, ["invoke", "cancel"]);
});

Deno.test("a drain deadline sends Cancel{SHUTDOWN} for invokes still running (#537)", async () => {
  const { gateway } = newGateway({
    maxConnectionAgeMs: 30,
    connectionDrainGraceMs: 50,
  });
  const w = await connectWorker(gateway, { tcp: true });
  const invoked = gateway.invoke(INVOKE, 5_000, MESSAGE);
  await tick();
  const [invokeId] = w.invokes;

  // Past the max age (± 10 %) and the drain grace, with the invoke running.
  const error = await assertRejects(() => invoked, ActivityInvokeError);
  assertEquals(error.code, "WORKER_DISCONNECTED");
  await w.ended;
  assertEquals(w.cancels, [{ invokeId, reason: CANCEL_REASON.SHUTDOWN }]);
  assertEquals(gateway.listRegisteredActors(), []);
});
