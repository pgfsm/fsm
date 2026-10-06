// SPEC-007 "claim is capacity-bounded", against a real database: the poll
// loop, through claim_pending_async_operation_events_with_capacity_v2, never
// has more invokes of an actor in flight than its workers' Σ max_concurrency,
// however many messages are queued. And #396: a message whose invoke fails
// retriably (the worker disconnects) isn't archived; it is delivered again
// once its visibility timeout ends, with a higher readCount. Needs
// DATABASE_URL (e.g. local Supabase); skipped otherwise.

import { assert, assertEquals } from "@std/assert";
// @ts-types="@types/pg"
import { Pool } from "pg";
import {
  InvokeResult,
  Register,
  RegisteredActor,
  SessionRequest,
  type SessionResponse,
} from "@pgfsm/proto-codegen/sidecargateway/v1/pb";
import { startAsyncOpPollLoop } from "../src/asyncOpPollLoop.ts";
import { SidecarGateway } from "../src/sidecar/gateway.ts";

type SessionRequestMessage = InstanceType<typeof SessionRequest>;
type SessionResponseMessage = InstanceType<typeof SessionResponse>;

const DATABASE_URL = Deno.env.get("DATABASE_URL");

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(20);
  }
}

Deno.test({
  name:
    "the poll loop keeps an actor's in-flight invokes within Σ max_concurrency, and redelivers retriable failures",
  ignore: !DATABASE_URL,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    const deps = { db: pool, useSupabase: false };
    const actorName = `cap${crypto.randomUUID().slice(0, 6)}`;
    const identity = {
      parentFsmName: "capFsm",
      parentFsmVersion: "v01",
      asyncOperationType: "internalAsyncOperation",
      asyncOperationName: actorName,
      asyncOperationVersion: "v01",
      asyncOperationLanguage: "go",
    };
    const queue = (await pool.query(
      "SELECT fsm_core.compute_async_operation_queue_name_v2($1,$2,$3,$4,$5,$6) AS q",
      Object.values(identity),
    )).rows[0].q as string;
    await pool.query("SELECT pgmq.create($1)", [queue]);
    await pool.query(
      `SELECT pgmq.send($1, jsonb_build_object(
         'eventData', jsonb_build_object('eventPayload', jsonb_build_object('n', n), 'actionType', 'xstate.invoke'),
         'sendToParentQueueId', gen_random_uuid()::text,
         'sendToParentQueueIdEventName', 'event-' || n))
       FROM generate_series(1, 6) n`,
      [queue],
    );

    const gateway = new SidecarGateway({ socketPath: "/unused" });
    const controller = new AbortController();
    try {
      // One worker declaring max_concurrency 2, which only records invokes.
      const requests = new PushStream<SessionRequestMessage>();
      requests.push(
        new SessionRequest({
          payload: {
            case: "register",
            value: new Register({
              workerId: "w",
              language: "go",
              protocolVersion: "1.0",
              actors: [
                new RegisteredActor({
                  ...identity,
                  maxConcurrency: 2,
                  timeoutMs: 3_000,
                }),
              ],
            }),
          },
        }),
      );
      const responses = (gateway as unknown as {
        handleSession(
          r: AsyncIterable<SessionRequestMessage>,
        ): AsyncIterable<SessionResponseMessage>;
      }).handleSession(requests)[Symbol.asyncIterator]();
      assertEquals((await responses.next()).value?.payload.case, "registerAck");
      const received: string[] = [];
      let peakInFlight = 0;
      (async () => {
        while (true) {
          const { value, done } = await responses.next();
          if (done) return;
          if (value.payload.case === "invoke") {
            received.push(value.payload.value.invokeId);
            peakInFlight = Math.max(
              peakInFlight,
              gateway.routingSnapshot()[0]?.inFlight ?? 0,
            );
          }
        }
      })();

      // timeout_ms 3000 + vt margin 1 s: claimed messages hide for 4 s.
      startAsyncOpPollLoop(gateway, deps, {
        intervalMs: 100,
        vtMarginSeconds: 1,
        maxDeliveryAttempts: 5,
        signal: controller.signal,
      });

      // Two claimed and dispatched; the other four stay queued, many ticks
      // later, because the worker has no free slot.
      await waitFor(() => received.length === 2, 5_000);
      await sleep(500);
      assertEquals(received.length, 2);
      assertEquals(gateway.listClaimableActors()[0].freeSlots, 0);

      // Finishing one frees one slot: exactly one more is claimed.
      requests.push(
        new SessionRequest({
          payload: {
            case: "invokeResult",
            value: new InvokeResult({
              invokeId: received[0],
              outputJson: "null",
            }),
          },
        }),
      );
      await waitFor(() => received.length === 3, 5_000);
      await sleep(500);
      assertEquals(received.length, 3);
      assert(peakInFlight <= 2, `peak in-flight ${peakInFlight} > 2`);

      // The two still in flight time out after 3 s (retriable), so they
      // aren't archived: they come back once their 4 s visibility timeout
      // ends and a slot is free, with read_ct 2. Only the one answered
      // successfully may have been archived.
      await sleep(7_000);
      const readCounts = (await pool.query(
        `SELECT read_ct FROM pgmq.q_${queue.toLowerCase()} ORDER BY msg_id`,
      )).rows.map((r: { read_ct: number }) => r.read_ct);
      assert(
        readCounts.length >= 5,
        `only the successful invoke may be archived, left: ${readCounts}`,
      );
      assert(
        readCounts.some((c: number) => c >= 2),
        `expected a redelivered message, read counts: ${readCounts}`,
      );
      assert(peakInFlight <= 2, `peak in-flight ${peakInFlight} > 2`);
      requests.close();
    } finally {
      controller.abort();
      await gateway.stop();
      await pool.query("SELECT pgmq.drop_queue($1)", [queue]);
      await pool.end();
    }
  },
});
