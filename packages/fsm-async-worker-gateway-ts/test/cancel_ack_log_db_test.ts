// SPEC-012 (c), #539 against a real database: every acknowledged
// non-shutdown cancel writes exactly one cancel_acknowledged row in
// fsm_async_operation_queue_event_logs, with the reason, outcome and latency,
// and a SHUTDOWN cancel writes none. The gateway is wired as
// startActivityGatewayServer wires it (onCancelAcknowledged →
// recordCancelAck). Needs DATABASE_URL (e.g. local Supabase); skipped
// otherwise.

import { assert, assertEquals } from "@std/assert";
// @ts-types="@types/pg"
import { Pool } from "pg";
import {
  InvokeError,
  InvokeErrorDetail,
  InvokeResult,
  Register,
  RegisteredActor,
  SessionRequest,
  type SessionResponse,
} from "@pgfsm/proto-codegen/sidecargateway/v1/pb";
import type { DBDeps } from "@pgfsm/db";
import { recordCancelAck } from "../src/cancelAckLog.ts";
import {
  type ActivityInvokeInput,
  CANCEL_REASON,
  SidecarGateway,
} from "../src/sidecar/gateway.ts";

type SessionRequestMessage = InstanceType<typeof SessionRequest>;
type SessionResponseMessage = InstanceType<typeof SessionResponse>;

const DATABASE_URL = Deno.env.get("DATABASE_URL");
const integration = {
  ignore: !DATABASE_URL,
  sanitizeResources: false,
  sanitizeOps: false,
};

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

/**
 * A 2.0 worker on an in-memory session that answers every Cancel after
 * `replyAfterMs`: a STATE_EXITED one by stopping (InvokeError CANCELLED), any
 * other by finishing anyway (InvokeResult).
 */
async function connectWorker(gateway: SidecarGateway, replyAfterMs: number) {
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
  const cancels: number[] = [];
  const invokes: string[] = [];
  (async () => {
    while (true) {
      const { value, done } = await responses.next();
      if (done) return;
      if (value.payload.case === "invoke") {
        invokes.push(value.payload.value.invokeId);
      }
      if (value.payload.case !== "cancel") continue;
      const { invokeId, reason } = value.payload.value;
      cancels.push(reason);
      if (reason === CANCEL_REASON.SHUTDOWN) continue;
      setTimeout(() => {
        requests.push(
          new SessionRequest({
            payload: reason === CANCEL_REASON.STATE_EXITED
              ? {
                case: "invokeError",
                value: new InvokeError({
                  invokeId,
                  error: new InvokeErrorDetail({
                    code: "CANCELLED",
                    message: "handler stopped",
                    retriable: false,
                  }),
                }),
              }
              : {
                case: "invokeResult",
                value: new InvokeResult({ invokeId, outputJson: "{}" }),
              },
          }),
        );
      }, replyAfterMs);
    }
  })();
  return { cancels, invokes };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A gateway wired like startActivityGatewayServer's, and its writes. */
function gatewayRecordingAcks(deps: DBDeps) {
  const writes: Promise<boolean>[] = [];
  const gateway = new SidecarGateway({
    socketPath: "/unused",
    onCancelAcknowledged: (ack) => writes.push(recordCancelAck(deps, ack)),
  });
  return { gateway, writes };
}

/** A fresh queue with one message, as the poll loop would have claimed it. */
async function queuedMessage(pool: Pool) {
  const queueName = `t539_${crypto.randomUUID().slice(0, 8)}`;
  await pool.query(`SELECT pgmq.create($1)`, [queueName]);
  const { rows } = await pool.query<{ id: string }>(
    `SELECT pgmq.send($1, '{"invoke": 1}'::jsonb)::text AS id`,
    [queueName],
  );
  return { queueName, msgId: Number(rows[0].id) };
}

async function ackRows(pool: Pool, message: { queueName: string }) {
  const { rows } = await pool.query<{
    event_name: string;
    msg_id: string;
    event_data: {
      invoke_id: string;
      reason: string;
      outcome: string;
      cancel_to_ack_ms: number;
    };
  }>(
    `SELECT event_name, async_operation_queue_msg_id::text AS msg_id, event_data
       FROM fsm_core.fsm_async_operation_queue_event_logs
      WHERE async_operation_queue_name = $1 AND event_status = 'cancel_acknowledged'`,
    [message.queueName],
  );
  return rows;
}

async function withPool(fn: (pool: Pool, deps: DBDeps) => Promise<void>) {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
  try {
    await fn(pool, { db: pool, useSupabase: false });
  } finally {
    await pool.end();
  }
}

Deno.test({
  name:
    "a STATE_EXITED cancel the worker aborts writes one cancel_acknowledged row (#539)",
  ...integration,
  fn: () =>
    withPool(async (pool, deps) => {
      const { gateway, writes } = gatewayRecordingAcks(deps);
      try {
        await connectWorker(gateway, 50);
        const message = await queuedMessage(pool);
        const invoked = gateway.invoke(INVOKE, 30_000, message);
        invoked.catch(() => {});
        assertEquals(
          gateway.cancelByMessage(message, CANCEL_REASON.STATE_EXITED),
          1,
        );
        while (writes.length === 0) await sleep(10);
        assertEquals(await Promise.all(writes), [true]);

        const rows = await ackRows(pool, message);
        assertEquals(rows.length, 1);
        assertEquals(rows[0].event_name, "cancel_ack");
        assertEquals(rows[0].msg_id, String(message.msgId));
        assertEquals(rows[0].event_data.reason, "STATE_EXITED");
        assertEquals(rows[0].event_data.outcome, "aborted");
        assert(rows[0].event_data.invoke_id.length > 0);
        assert(
          rows[0].event_data.cancel_to_ack_ms >= 40,
          `latency ${rows[0].event_data.cancel_to_ack_ms}ms`,
        );
      } finally {
        await gateway.stop();
      }
    }),
});

Deno.test({
  name:
    "a TIMEOUT cancel the worker finishes anyway writes one row with outcome completed (#539)",
  ...integration,
  fn: () =>
    withPool(async (pool, deps) => {
      const { gateway, writes } = gatewayRecordingAcks(deps);
      try {
        await connectWorker(gateway, 20);
        const message = await queuedMessage(pool);
        const invoked = gateway.invoke(INVOKE, 50, message);
        invoked.catch(() => {});
        while (writes.length === 0) await sleep(10);
        assertEquals(await Promise.all(writes), [true]);

        const rows = await ackRows(pool, message);
        assertEquals(rows.length, 1);
        assertEquals(rows[0].event_data.reason, "TIMEOUT");
        assertEquals(rows[0].event_data.outcome, "completed");
      } finally {
        await gateway.stop();
      }
    }),
});

Deno.test({
  name: "a SHUTDOWN cancel writes no row (#539)",
  ...integration,
  fn: () =>
    withPool(async (pool, deps) => {
      const { gateway, writes } = gatewayRecordingAcks(deps);
      const worker = await connectWorker(gateway, 0);
      const message = await queuedMessage(pool);
      const invoked = gateway.invoke(INVOKE, 30_000, message);
      invoked.catch(() => {});
      while (worker.invokes.length === 0) await sleep(10);
      await gateway.stop();
      while (worker.cancels.length === 0) await sleep(10);
      assertEquals(worker.cancels, [CANCEL_REASON.SHUTDOWN]);
      await sleep(100);
      await Promise.all(writes);
      assertEquals(await ackRows(pool, message), []);
    }),
});
