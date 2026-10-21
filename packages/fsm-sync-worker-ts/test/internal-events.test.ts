import { assertEquals } from "@std/assert";
import type { Database, Json } from "@pgfsm/db/database.types";
import {
  archiveOutcome,
  hasInternalEvents,
  internalEventMessage,
  isActiveStatus,
  nextInternalEvent,
  takeNextEvent,
} from "../src/fsmlet/internal-events.ts";

type MessageRecord = Database["pgmq"]["CompositeTypes"]["message_record"];
type FsmInstanceRow = Database["fsm_core"]["Tables"]["fsm_instance"]["Row"];

const doneState = { eventType: "xstate.done.state.loadTest.Working" };
const cancel: MessageRecord = {
  msg_id: 7,
  read_ct: 1,
  enqueued_at: null,
  vt: null,
  message: { eventData: { eventType: "CANCEL" } },
};

/** An instance row with the given internal event queue. */
const row = (internal_event_queue: Json[]) =>
  ({
    id: "11112222-3333-4444-5555-666677778888",
    fsm_type: "fsm",
    fsm_version: "v01",
    internal_event_queue,
  }) as unknown as FsmInstanceRow;

/** Readers for takeNextEvent that record what was read. */
const source = (queue: Json[], pgmq: MessageRecord[]) => {
  const reads: string[] = [];
  return {
    reads,
    readInstance: () => {
      reads.push("instance");
      return Promise.resolve({ fsm_instance_row: row(queue) });
    },
    readQueueMessage: () => {
      reads.push("pgmq");
      return Promise.resolve(pgmq.shift());
    },
  };
};

Deno.test("takeNextEvent: an internal event goes before a pgmq message queued behind it (#520)", async () => {
  // The last region finished; the done.state it raised is on the internal
  // queue, and a CANCEL arrived on pgmq after it.
  const s = source([doneState], [cancel]);
  const taken = await takeNextEvent(true, s.readInstance, s.readQueueMessage);
  assertEquals(taken?.next.source, "internal");
  assertEquals(
    (taken?.next.msg.message as { eventData: Json }).eventData,
    {
      eventType: doneState.eventType,
      eventPayload: null,
      actionType: "internal",
    },
  );
  assertEquals(s.reads, ["instance"], "pgmq is not read");
});

Deno.test("takeNextEvent: with no internal events pending, the next pgmq message is taken", async () => {
  const s = source([], [cancel]);
  const taken = await takeNextEvent(false, s.readInstance, s.readQueueMessage);
  assertEquals(taken?.next, { source: "queue", msg: cancel });
  assertEquals(s.reads, ["pgmq", "instance"]);
});

Deno.test("takeNextEvent: an empty internal queue falls back to pgmq", async () => {
  const s = source([], [cancel]);
  const taken = await takeNextEvent(true, s.readInstance, s.readQueueMessage);
  assertEquals(taken?.next.source, "queue");
});

Deno.test("takeNextEvent: nothing to take is null", async () => {
  const s = source([], []);
  assertEquals(
    await takeNextEvent(false, s.readInstance, s.readQueueMessage),
    null,
  );
});

Deno.test("nextInternalEvent / hasInternalEvents read the queue's head and the archive's result", () => {
  assertEquals(
    nextInternalEvent(row([doneState, { eventType: "x" }])),
    doneState,
  );
  assertEquals(nextInternalEvent(row([])), null);
  assertEquals(nextInternalEvent(null), null);
  assertEquals(hasInternalEvents({ internal_event_queue: [doneState] }), true);
  assertEquals(hasInternalEvents({ internal_event_queue: [] }), false);
  assertEquals(hasInternalEvents(null), false);
});

Deno.test("internalEventMessage: an internal event is a queue message with no msg_id", () => {
  const msg = internalEventMessage(doneState, row([]));
  assertEquals(msg.msg_id, null);
  assertEquals(msg.message, {
    eventData: {
      eventType: doneState.eventType,
      eventPayload: null,
      actionType: "internal",
    },
    queueId: "11112222-3333-4444-5555-666677778888",
    queueType: "fsm",
    queueVersion: "v01",
  });
});

Deno.test("isActiveStatus: only active, or no status yet, takes more events (#534)", () => {
  assertEquals(isActiveStatus("active"), true);
  assertEquals(isActiveStatus(null), true);
  assertEquals(isActiveStatus(undefined), true);
  assertEquals(isActiveStatus("done"), false);
  assertEquals(isActiveStatus("error"), false);
  assertEquals(isActiveStatus("stopped"), false);
});

Deno.test("archiveOutcome reads the discard and the archive's status (#534)", () => {
  assertEquals(
    archiveOutcome(
      {
        discarded: true,
        discarded_reason: "instance_not_active",
        fsm_instance_status: "stopped",
      },
      "active",
    ),
    { discarded: true, reason: "instance_not_active", status: "stopped" },
  );
  // The cycle cap: the worker computed active, the archive saved error.
  assertEquals(
    archiveOutcome(
      { discarded: false, fsm_instance_status: "error" },
      "active",
    ),
    { discarded: false, reason: null, status: "error" },
  );
  // A result without a status (an older database) keeps the worker's.
  assertEquals(
    archiveOutcome({ internal_event_queue: [] }, "done"),
    { discarded: false, reason: null, status: "done" },
  );
  assertEquals(archiveOutcome(null, "active"), {
    discarded: false,
    reason: null,
    status: "active",
  });
});
