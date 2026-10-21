// SPEC-012 (c), #539: recordCancelAck writes a cancel acknowledgement through
// @pgfsm/db, skips SHUTDOWN cancels and invokes without a queue message, and
// never rejects. Against a fake pool; cancel_ack_log_db_test.ts covers the
// row itself.

import { assertEquals } from "@std/assert";
import type { DBDeps } from "@pgfsm/db";
import { recordCancelAck } from "../src/cancelAckLog.ts";
import {
  CANCEL_REASON,
  type CancelAcknowledgement,
} from "../src/sidecar/gateway.ts";

function fakeDeps(fail = false) {
  const calls: { text: string; values: unknown[] }[] = [];
  const deps = {
    db: {
      query(text: string, values: unknown[]) {
        calls.push({ text, values });
        if (fail) return Promise.reject(new Error("connection refused"));
        return Promise.resolve({ rows: [{ id: "row-1" }] });
      },
    },
    useSupabase: false,
  } as unknown as DBDeps;
  return { deps, calls };
}

const ACK: CancelAcknowledgement = {
  workerId: "w",
  invokeId: "invoke-1",
  actorKey: "k",
  reason: CANCEL_REASON.STATE_EXITED,
  outcome: "aborted",
  cancelToAckMs: 12.6,
  message: { queueName: "q", msgId: 7n },
};

Deno.test("recordCancelAck writes the reason by name, the outcome and the latency (#539)", async () => {
  const { deps, calls } = fakeDeps();
  assertEquals(await recordCancelAck(deps, ACK), true);
  assertEquals(calls.length, 1);
  assertEquals(
    calls[0].text.includes("fsm_core.log_async_operation_cancel_ack_v2("),
    true,
  );
  assertEquals(calls[0].values, [
    "q",
    "7",
    "invoke-1",
    "STATE_EXITED",
    "aborted",
    13,
  ]);
});

Deno.test("recordCancelAck writes nothing for a SHUTDOWN cancel (#539)", async () => {
  const { deps, calls } = fakeDeps();
  assertEquals(
    await recordCancelAck(deps, { ...ACK, reason: CANCEL_REASON.SHUTDOWN }),
    false,
  );
  assertEquals(calls, []);
});

Deno.test("recordCancelAck writes nothing for an invoke without a queue message (#539)", async () => {
  const { deps, calls } = fakeDeps();
  assertEquals(
    await recordCancelAck(deps, { ...ACK, message: undefined }),
    false,
  );
  assertEquals(calls, []);
});

Deno.test("recordCancelAck logs a failed write and resolves false (#539)", async () => {
  const { deps, calls } = fakeDeps(true);
  assertEquals(await recordCancelAck(deps, ACK), false);
  assertEquals(calls.length, 1);
});
