// SPEC-012 (b), #538 against a real database: the gateway learns that an
// in-flight invoke's state exited, by LISTEN on fsm_async_operation_cancel
// and by the sweep, and sends its worker Cancel{STATE_EXITED}. The cancel
// itself is what the FSM side does when the invoking state exits:
// finish_async_operation_event_v2('cancelled', queue, msg_id), which archives
// the message and notifies. Needs DATABASE_URL (e.g. local Supabase), and a
// direct connection there to LISTEN on; skipped otherwise.

import { assert, assertEquals } from "@std/assert";
// @ts-types="@types/pg"
import { Pool } from "pg";
import {
  Register,
  RegisteredActor,
  SessionRequest,
  type SessionResponse,
} from "@pgfsm/proto-codegen/sidecargateway/v1/pb";
import type { DBDeps } from "@pgfsm/db";
import {
  CANCEL_CHANNEL,
  startCancelDetection,
} from "../src/cancelDetection.ts";
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

/** A 2.0 worker on an in-memory session that records the cancels it gets. */
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
  const cancels: { at: number; reason: number }[] = [];
  (async () => {
    while (true) {
      const { value, done } = await responses.next();
      if (done) return;
      if (value.payload.case === "cancel") {
        cancels.push({ at: Date.now(), reason: value.payload.value.reason });
      }
    }
  })();
  return { cancels };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await sleep(20);
  }
  return true;
}

/** A fresh queue with one message, as the poll loop would have claimed it. */
async function queuedMessage(pool: Pool) {
  const queueName = `t538_${crypto.randomUUID().slice(0, 8)}`;
  await pool.query(`SELECT pgmq.create($1)`, [queueName]);
  const { rows } = await pool.query<{ id: string }>(
    `SELECT pgmq.send($1, '{"invoke": 1}'::jsonb)::text AS id`,
    [queueName],
  );
  return { queueName, msgId: Number(rows[0].id) };
}

/** What the FSM side does when the invoking state exits. */
async function cancelFromFsm(
  pool: Pool,
  message: { queueName: string; msgId: number },
) {
  await pool.query(
    `SELECT fsm_core.finish_async_operation_event_v2('cancelled', $1, $2::bigint)`,
    [message.queueName, message.msgId],
  );
}

/** pids of connections listening on the cancel channel. */
async function listenerPids(pool: Pool): Promise<number[]> {
  const { rows } = await pool.query<{ pid: number }>(
    `SELECT pid FROM pg_stat_activity WHERE query = $1`,
    [`LISTEN ${CANCEL_CHANNEL}`],
  );
  return rows.map((r) => r.pid);
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
    "LISTEN: Cancel{STATE_EXITED} reaches the worker within 1s of the cancel committing (#538)",
  ...integration,
  fn: () =>
    withPool(async (pool, deps) => {
      const gateway = new SidecarGateway({ socketPath: "/unused" });
      const worker = await connectWorker(gateway);
      const message = await queuedMessage(pool);
      const invoked = gateway.invoke(INVOKE, 30_000, message);
      invoked.catch(() => {});
      const detection = startCancelDetection(gateway, deps, {
        listenDbUrl: DATABASE_URL,
        sweepIntervalMs: 0, // LISTEN alone
      });
      try {
        // Wait until the listener is connected.
        const before = Date.now();
        while ((await listenerPids(pool)).length === 0) {
          assert(Date.now() - before < 10_000, "the listener never connected");
          await sleep(50);
        }
        const committed = Date.now();
        await cancelFromFsm(pool, message);
        assert(
          await waitFor(() => worker.cancels.length === 1, 1_000),
          "no Cancel within 1s",
        );
        assertEquals(worker.cancels[0].reason, CANCEL_REASON.STATE_EXITED);
        assert(worker.cancels[0].at - committed < 1_000);
      } finally {
        await detection.stop();
        await gateway.stop();
      }
    }),
});

Deno.test({
  name:
    "sweep only (no --listen-db-url): the cancel is detected within one sweep interval (#538)",
  ...integration,
  fn: () =>
    withPool(async (pool, deps) => {
      const gateway = new SidecarGateway({ socketPath: "/unused" });
      const worker = await connectWorker(gateway);
      const message = await queuedMessage(pool);
      const invoked = gateway.invoke(INVOKE, 30_000, message);
      invoked.catch(() => {});
      const detection = startCancelDetection(gateway, deps, {
        sweepIntervalMs: 200,
      });
      try {
        await cancelFromFsm(pool, message);
        assert(
          await waitFor(() => worker.cancels.length === 1, 1_000),
          "no Cancel within a sweep interval (+ margin)",
        );
        assertEquals(worker.cancels[0].reason, CANCEL_REASON.STATE_EXITED);
      } finally {
        await detection.stop();
        await gateway.stop();
      }
    }),
});

Deno.test({
  name:
    "with the listener's connection killed during a cancel, the sweep still cancels and the listener reconnects (#538)",
  ...integration,
  fn: () =>
    withPool(async (pool, deps) => {
      const gateway = new SidecarGateway({ socketPath: "/unused" });
      const worker = await connectWorker(gateway);
      const message = await queuedMessage(pool);
      const invoked = gateway.invoke(INVOKE, 30_000, message);
      invoked.catch(() => {});
      const detection = startCancelDetection(gateway, deps, {
        listenDbUrl: DATABASE_URL,
        sweepIntervalMs: 300,
        reconnectInitialDelayMs: 100,
      });
      try {
        let pids: number[] = [];
        const started = Date.now();
        while ((pids = await listenerPids(pool)).length === 0) {
          assert(Date.now() - started < 10_000, "the listener never connected");
          await sleep(50);
        }
        // Kill the listener, then cancel while it is gone.
        await pool.query(
          `SELECT pg_terminate_backend(pid) FROM unnest($1::int[]) pid`,
          [
            pids,
          ],
        );
        await cancelFromFsm(pool, message);
        assert(
          await waitFor(() => worker.cancels.length === 1, 3_000),
          "the cancel was never detected",
        );
        assertEquals(worker.cancels[0].reason, CANCEL_REASON.STATE_EXITED);
        // And it listens again, on a new connection.
        const reconnected = Date.now();
        let now: number[] = [];
        while (
          (now = await listenerPids(pool)).length === 0 ||
          now.some((pid) => pids.includes(pid))
        ) {
          assert(
            Date.now() - reconnected < 10_000,
            "the listener never reconnected",
          );
          await sleep(50);
        }
      } finally {
        await detection.stop();
        await gateway.stop();
      }
    }),
});

Deno.test({
  name: "two replicas: only the one running the invoke sends Cancel (#538)",
  ...integration,
  fn: () =>
    withPool(async (pool, deps) => {
      const running = new SidecarGateway({ socketPath: "/unused" });
      const other = new SidecarGateway({ socketPath: "/unused" });
      const runningWorker = await connectWorker(running);
      const otherWorker = await connectWorker(other);
      const message = await queuedMessage(pool);
      const invoked = running.invoke(INVOKE, 30_000, message);
      invoked.catch(() => {});
      const detections = [running, other].map((gateway) =>
        startCancelDetection(gateway, deps, {
          listenDbUrl: DATABASE_URL,
          sweepIntervalMs: 200,
        })
      );
      try {
        const started = Date.now();
        while ((await listenerPids(pool)).length < 2) {
          assert(
            Date.now() - started < 10_000,
            "the listeners never connected",
          );
          await sleep(50);
        }
        await cancelFromFsm(pool, message);
        assert(
          await waitFor(() => runningWorker.cancels.length === 1, 1_000),
          "the running replica sent no Cancel",
        );
        await sleep(500); // a sweep or two on the other replica
        assertEquals(otherWorker.cancels, []);
        assertEquals(runningWorker.cancels.length, 1);
      } finally {
        await Promise.all(detections.map((d) => d.stop()));
        await running.stop();
        await other.stop();
      }
    }),
});
