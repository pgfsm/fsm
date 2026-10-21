// SPEC-012 (d), #540: every handler gets an AbortSignal, and the SDK honours
// Cancel. Against a real in-process SidecarGateway (Cancel{STATE_EXITED} via
// cancelByMessage, Cancel{TIMEOUT} via a short invoke timeout, with the
// gateway's own acknowledgement outcome), and against a scripted sidecar for
// what the gateway doesn't do on demand: a session that just ends, a cancel
// of an unknown invoke, a cancel of an invoke still waiting for its slot, and
// a rejected registration.

import { assert, assertEquals, assertRejects } from "@std/assert";
import * as http2 from "node:http2";
import type { ConnectRouter, ServiceImpl } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { SidecarGatewayService } from "@pgfsm/proto-codegen/sidecargateway/v1/connect";
import {
  Cancel,
  CancelReason,
  Invoke,
  RegisterAck,
  type SessionRequest,
  SessionResponse,
} from "@pgfsm/proto-codegen/sidecargateway/v1/pb";
import {
  ActivityInvokeError,
  CANCEL_REASON as GATEWAY_CANCEL_REASON,
  type CancelAcknowledgement,
  SidecarGateway,
} from "@pgfsm/async-worker-gateway";
import {
  type ActorRegistration,
  ActorWorker,
  CANCEL_REASON,
  cancelReasonName,
  InvokeCancelledError,
  RegistrationRejectedError,
  runActorWorkerCli,
  SIDECAR_PROTOCOL_VERSION,
} from "../src/index.ts";

type SessionRequestMessage = InstanceType<typeof SessionRequest>;
type SessionResponseMessage = InstanceType<typeof SessionResponse>;

const IDENTITY = {
  parentFsmName: "creditCheck",
  parentFsmVersion: "v01",
  asyncOperationType: "fsm",
  asyncOperationVersion: "v01",
  asyncOperationLanguage: "typescript",
};

/** What a handler saw: when it started, and its signal's abort reason. */
interface Seen {
  started: number;
  reasons: unknown[];
}

/**
 * `waitThenThrow` waits for its abort and rethrows it (a handler that
 * stops); `waitThenReturn` waits for it and returns anyway (one that
 * finishes regardless).
 */
function registrations(seen: Seen): ActorRegistration[] {
  const waitForAbort = (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      seen.started++;
      signal.addEventListener("abort", () => {
        seen.reasons.push(signal.reason);
        resolve();
      });
    });
  return [
    {
      ...IDENTITY,
      asyncOperationName: "waitThenThrow",
      handler: async (_input, signal) => {
        await waitForAbort(signal);
        signal.throwIfAborted();
      },
    },
    {
      ...IDENTITY,
      asyncOperationName: "waitThenReturn",
      handler: async (_input, signal) => {
        await waitForAbort(signal);
        return { finishedAnyway: true };
      },
    },
  ];
}

function invokeOf(asyncOperationName: string) {
  return {
    ...IDENTITY,
    asyncOperationName,
    input: {},
    instanceId: "instance-1",
    correlationId: "corr-1",
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A real gateway with one worker serving `registrations(seen)`. */
async function withGateway(
  fn: (ctx: {
    gateway: SidecarGateway;
    seen: Seen;
    acks: CancelAcknowledgement[];
  }) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  const socketPath = `${dir}/sidecar.sock`;
  const acks: CancelAcknowledgement[] = [];
  const gateway = new SidecarGateway({
    socketPath,
    onCancelAcknowledged: (ack) => acks.push(ack),
  });
  await gateway.start();
  const seen: Seen = { started: 0, reasons: [] };
  const worker = new ActorWorker(
    {
      workerId: "cancel-worker",
      language: "typescript",
      gatewaySocketPath: socketPath,
      heartbeatMs: 50,
      shutdownGraceMs: 100,
    },
    registrations(seen),
  );
  const running = worker.run();
  try {
    await waitFor(() => gateway.listRegisteredActors().length === 2);
    await fn({ gateway, seen, acks });
  } finally {
    await worker.stop();
    await running;
    await gateway.stop();
    await Deno.remove(dir, { recursive: true });
  }
}

const sanitize = { sanitizeOps: false, sanitizeResources: false };

Deno.test("CANCEL_REASON matches the proto's CancelReason", () => {
  assertEquals(CANCEL_REASON.UNSPECIFIED, CancelReason.UNSPECIFIED);
  assertEquals(CANCEL_REASON.STATE_EXITED, CancelReason.STATE_EXITED);
  assertEquals(CANCEL_REASON.TIMEOUT, CancelReason.TIMEOUT);
  assertEquals(CANCEL_REASON.SHUTDOWN, CancelReason.SHUTDOWN);
  assertEquals(cancelReasonName(2), "TIMEOUT");
  assertEquals(cancelReasonName(99), "UNSPECIFIED");
  assertEquals(SIDECAR_PROTOCOL_VERSION, "2.0");
});

Deno.test({
  name:
    "Cancel{STATE_EXITED}: the handler's signal aborts, and its throw is acknowledged as CANCELLED (#540)",
  ...sanitize,
  fn: () =>
    withGateway(async ({ gateway, seen, acks }) => {
      const message = { queueName: "q", msgId: 1 };
      const invoked = gateway.invoke(
        invokeOf("waitThenThrow"),
        30_000,
        message,
      );
      invoked.catch(() => {});
      await waitFor(() => seen.started === 1);
      assertEquals(
        gateway.cancelByMessage(message, GATEWAY_CANCEL_REASON.STATE_EXITED),
        1,
      );
      const error = await assertRejects(() => invoked, ActivityInvokeError);
      assertEquals(error.code, "CANCELLED");

      await waitFor(() => acks.length === 1);
      assertEquals(acks[0].outcome, "aborted");
      assertEquals(seen.reasons.length, 1);
      const reason = seen.reasons[0];
      assert(reason instanceof InvokeCancelledError);
      assertEquals(reason.cancelReason, "STATE_EXITED");
    }),
});

Deno.test({
  name:
    "a handler that returns after the abort is sent as InvokeResult: completed anyway (#540)",
  ...sanitize,
  fn: () =>
    withGateway(async ({ gateway, seen, acks }) => {
      const message = { queueName: "q", msgId: 2 };
      const invoked = gateway.invoke(
        invokeOf("waitThenReturn"),
        30_000,
        message,
      );
      invoked.catch(() => {});
      await waitFor(() => seen.started === 1);
      gateway.cancelByMessage(message, GATEWAY_CANCEL_REASON.STATE_EXITED);
      await waitFor(() => acks.length === 1);
      assertEquals(acks[0].outcome, "completed");
    }),
});

Deno.test({
  name: "Cancel{TIMEOUT}: the handler's signal aborts with TIMEOUT (#540)",
  ...sanitize,
  fn: () =>
    withGateway(async ({ gateway, seen, acks }) => {
      const invoked = gateway.invoke(invokeOf("waitThenThrow"), 100, {
        queueName: "q",
        msgId: 3,
      });
      const error = await assertRejects(() => invoked, ActivityInvokeError);
      assertEquals(error.code, "TIMEOUT");
      await waitFor(() => acks.length === 1);
      assertEquals(acks[0].outcome, "aborted");
      assertEquals(
        (seen.reasons[0] as InvokeCancelledError).cancelReason,
        "TIMEOUT",
      );
    }),
});

/**
 * A scripted sidecar: acks registration (`accepted`), then yields whatever
 * the test pushes, and records what the worker sends.
 */
async function scriptedSidecar(accepted = true) {
  const dir = await Deno.makeTempDir();
  const socketPath = `${dir}/sidecar.sock`;
  const fromWorker: SessionRequestMessage[] = [];
  const toWorker: Array<SessionResponseMessage | "end"> = [];
  let sessions = 0;
  async function* session(
    requests: AsyncIterable<SessionRequestMessage>,
  ): AsyncIterable<SessionResponseMessage> {
    sessions++;
    const iterator = requests[Symbol.asyncIterator]();
    await iterator.next(); // register
    // Like the real gateway, end the session once the worker closes its side.
    let workerClosed = false;
    (async () => {
      while (true) {
        const { value, done } = await iterator.next();
        if (done) break;
        fromWorker.push(value);
      }
    })().catch(() => {}).finally(() => workerClosed = true);
    yield new SessionResponse({
      payload: { case: "registerAck", value: new RegisterAck({ accepted }) },
    });
    if (!accepted) return;
    while (!workerClosed) {
      const next = toWorker.shift();
      if (next === "end") return;
      if (next) yield next;
      else await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
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
  return {
    socketPath,
    fromWorker,
    sessions: () => sessions,
    invoke(invokeId: string, asyncOperationName: string) {
      toWorker.push(
        new SessionResponse({
          payload: {
            case: "invoke",
            value: new Invoke({
              invokeId,
              ...IDENTITY,
              asyncOperationName,
              inputJson: "{}",
            }),
          },
        }),
      );
    },
    cancel(invokeId: string, reason: number) {
      toWorker.push(
        new SessionResponse({
          payload: { case: "cancel", value: new Cancel({ invokeId, reason }) },
        }),
      );
    },
    end() {
      toWorker.push("end");
    },
    replies() {
      return fromWorker.flatMap((r) =>
        r.payload.case === "invokeResult"
          ? [{ invokeId: r.payload.value.invokeId, code: "RESULT" }]
          : r.payload.case === "invokeError"
          ? [{
            invokeId: r.payload.value.invokeId,
            code: r.payload.value.error?.code ?? "",
          }]
          : []
      );
    },
    async close() {
      server.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

function scriptedWorker(
  socketPath: string,
  regs: ActorRegistration[],
  extra: Record<string, number> = {},
) {
  return new ActorWorker(
    {
      workerId: "scripted",
      language: "typescript",
      gatewaySocketPath: socketPath,
      heartbeatMs: 50,
      reconnectInitialDelayMs: 10,
      reconnectMaxDelayMs: 20,
      ...extra,
    },
    regs,
  );
}

Deno.test({
  name:
    "when the session ends, every running invoke's signal aborts with SHUTDOWN (#540)",
  ...sanitize,
  fn: async () => {
    const sidecar = await scriptedSidecar();
    const seen: Seen = { started: 0, reasons: [] };
    const worker = scriptedWorker(sidecar.socketPath, registrations(seen), {
      maxConcurrency: 2,
    });
    const running = worker.run();
    try {
      sidecar.invoke("a", "waitThenThrow");
      sidecar.invoke("b", "waitThenReturn");
      await waitFor(() => seen.started === 2);
      sidecar.end();
      await waitFor(() => seen.reasons.length === 2);
      for (const reason of seen.reasons) {
        assert(reason instanceof InvokeCancelledError);
        assertEquals(reason.cancelReason, "SHUTDOWN");
      }
    } finally {
      await worker.stop();
      await running;
      await sidecar.close();
    }
  },
});

Deno.test({
  name:
    "a cancel of an unknown invoke is ignored; one waiting for its slot never runs (#540)",
  ...sanitize,
  fn: async () => {
    const sidecar = await scriptedSidecar();
    const seen: Seen = { started: 0, reasons: [] };
    // One slot: "second" waits behind "first".
    const worker = scriptedWorker(sidecar.socketPath, registrations(seen), {
      shutdownGraceMs: 100,
    });
    const running = worker.run();
    try {
      sidecar.cancel("unknown", CANCEL_REASON.STATE_EXITED);
      sidecar.invoke("first", "waitThenReturn");
      sidecar.invoke("second", "waitThenReturn");
      await waitFor(() => seen.started === 1);
      sidecar.cancel("second", CANCEL_REASON.STATE_EXITED);
      await waitFor(() => sidecar.replies().length === 1);
      assertEquals(sidecar.replies(), [{
        invokeId: "second",
        code: "CANCELLED",
      }]);

      sidecar.cancel("first", CANCEL_REASON.TIMEOUT);
      await waitFor(() => sidecar.replies().length === 2);
      assertEquals(sidecar.replies()[1], { invokeId: "first", code: "RESULT" });
      // "second" never started.
      assertEquals(seen.started, 1);
    } finally {
      await worker.stop();
      await running;
      await sidecar.close();
    }
  },
});

Deno.test({
  name:
    "a rejected registration fails run() without reconnecting, and the CLI exits 1 (#540)",
  ...sanitize,
  fn: async () => {
    const sidecar = await scriptedSidecar(false);
    try {
      const seen: Seen = { started: 0, reasons: [] };
      await assertRejects(
        () => scriptedWorker(sidecar.socketPath, registrations(seen)).run(),
        RegistrationRejectedError,
      );
      assertEquals(sidecar.sessions(), 1);

      const code = await runActorWorkerCli({
        registrations: registrations(seen),
        args: ["start", "--gateway-socket", sidecar.socketPath],
      });
      assertEquals(code, 1);
      assertEquals(sidecar.sessions(), 2);
    } finally {
      await sidecar.close();
    }
  },
});
