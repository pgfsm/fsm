// #396: dispatchAndArchive leaves retriable failures on the queue for
// redelivery (up to maxDeliveryAttempts), archives everything else, and the
// SPEC-007 timeout helpers derive a visibility timeout that outlasts the
// invoke. A fake `deps.db` records whether anything was archived.

import { assertEquals } from "@std/assert";
import type { DBDeps } from "@pgfsm/db";
import {
  dispatchAndArchive,
  effectiveTimeoutMs,
  parseClaimedAsyncOperationEvent,
  visibilityTimeoutSeconds,
} from "../src/asyncOpPollLoop.ts";
import { ActivityInvokeError, SidecarGateway } from "../src/sidecar/gateway.ts";

function fakeDeps(): { deps: DBDeps; archived: unknown[][] } {
  const archived: unknown[][] = [];
  const db = {
    query: (_text: string, values: unknown[]) => {
      archived.push(values);
      return Promise.resolve({ rows: [{ result: null }] });
    },
  };
  return { deps: { db, useSupabase: false } as unknown as DBDeps, archived };
}

function claimedRow(readCount: number) {
  return parseClaimedAsyncOperationEvent({
    parentFsmName: "creditCheck",
    parentFsmVersion: "v01",
    asyncOperationType: "internalAsyncOperation",
    asyncOperationName: "checkBureau",
    asyncOperationVersion: "v01",
    asyncOperationLanguage: "python",
    input: {},
    instanceId: "instance-1",
    correlationId: "42",
    asyncOperationQueueName: "q",
    asyncOperationQueueType: "internalAsyncOperation",
    asyncOperationQueueVersion: "v01",
    msgId: 42,
    eventName: "0.(machine).creditCheck.Fetching",
    eventActionType: "xstate.invoke",
    eventDelay: 0,
    sendToParentQueueId: "instance-1",
    sendToParentQueueIdEventName: "0.(machine).creditCheck.Fetching",
    readCount,
  })!;
}

/** A sidecar whose invoke() always fails with `error`. */
function failingSidecar(error: Error): SidecarGateway {
  const sidecar = new SidecarGateway({ socketPath: "/unused" });
  sidecar.invoke = () => Promise.reject(error);
  return sidecar;
}

Deno.test("a retriable failure is left for redelivery, not archived (#396)", async () => {
  for (
    const code of [
      "ACTOR_NOT_FOUND",
      "WORKER_UNAVAILABLE",
      "WORKER_DISCONNECTED",
      "TIMEOUT",
    ]
  ) {
    const { deps, archived } = fakeDeps();
    await dispatchAndArchive(
      failingSidecar(new ActivityInvokeError(code, code, true)),
      deps,
      claimedRow(1),
      1_000,
      5,
    );
    assertEquals(archived.length, 0, code);
  }
});

Deno.test("a retriable failure is archived as an actor error once delivery attempts run out", async () => {
  const { deps, archived } = fakeDeps();
  await dispatchAndArchive(
    failingSidecar(new ActivityInvokeError("timed out", "TIMEOUT", true)),
    deps,
    claimedRow(5),
    1_000,
    5,
  );
  assertEquals(archived.length, 1);
  const values = archived[0];
  assertEquals(
    values.includes("xstate.error.actor.0.(machine).creditCheck.Fetching"),
    true,
  );
  assertEquals(values.includes("failed"), true);
});

Deno.test("a non-retriable failure (the actor threw) is archived on the first delivery", async () => {
  const { deps, archived } = fakeDeps();
  await dispatchAndArchive(
    failingSidecar(new ActivityInvokeError("boom", "INTERNAL", false)),
    deps,
    claimedRow(1),
    1_000,
    5,
  );
  assertEquals(archived.length, 1);
});

Deno.test("claimed rows without readCount (the old claim function) count as delivery 1", () => {
  const row = claimedRow(3) as unknown as Record<string, unknown>;
  delete row.readCount;
  assertEquals(parseClaimedAsyncOperationEvent(row)?.readCount, 1);
});

Deno.test("the visibility timeout outlasts the invoke timeout (SPEC-007 §6)", () => {
  assertEquals(effectiveTimeoutMs(0, 10_000), 10_000);
  assertEquals(effectiveTimeoutMs(45_000, 10_000), 45_000);
  assertEquals(visibilityTimeoutSeconds(10_000, 10), 20);
  assertEquals(visibilityTimeoutSeconds(45_500, 10), 56);
});
