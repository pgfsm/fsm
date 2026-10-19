import type { Database, Json } from "@pgfsm/db/database.types";

type MessageRecord = Database["pgmq"]["CompositeTypes"]["message_record"];
type FsmInstanceRow = Database["fsm_core"]["Tables"]["fsm_instance"]["Row"];

/**
 * The next event for an instance's worker: the head of its internal event
 * queue, or a message from its pgmq queue. Both are handled the same way; an
 * internal event comes as a queue message with no `msg_id` (it isn't on
 * pgmq), and the archive is told which internal event it was.
 */
export type NextEvent =
  | { source: "internal"; event: Json; msg: MessageRecord }
  | { source: "queue"; msg: MessageRecord };

/** The head of an instance's internal event queue (SPEC-010), or null. */
export function nextInternalEvent(
  row: Pick<FsmInstanceRow, "internal_event_queue"> | null | undefined,
): Json | null {
  const queue = row?.internal_event_queue;
  return Array.isArray(queue) && queue.length > 0 ? queue[0] : null;
}

/** Whether an archive result says internal events are still waiting. */
export function hasInternalEvents(archiveResult: Json): boolean {
  const queue = archiveResult !== null && typeof archiveResult === "object" &&
      !Array.isArray(archiveResult)
    ? archiveResult.internal_event_queue
    : undefined;
  return Array.isArray(queue) && queue.length > 0;
}

/**
 * An internal event in the shape of a message from the instance's queue, so
 * transition selection, guards and actions see it as they see any event. A
 * raised event is `{ eventType }`; it has no payload.
 */
export function internalEventMessage(
  event: Json,
  row: Pick<FsmInstanceRow, "id" | "fsm_type" | "fsm_version">,
): MessageRecord {
  const raised = event !== null && typeof event === "object" &&
      !Array.isArray(event)
    ? event
    : {};
  return {
    msg_id: null,
    read_ct: null,
    enqueued_at: null,
    vt: null,
    message: {
      eventData: {
        eventType: raised.eventType ?? null,
        eventPayload: raised.eventPayload ?? null,
        actionType: "internal",
      },
      queueId: row.id,
      queueType: row.fsm_type,
      queueVersion: row.fsm_version,
    },
  };
}

/**
 * Takes the instance's next event, internal events first: XState's macrostep
 * drains its internal queue before it takes another event, so an event that
 * arrives after the one that finished a region can't overtake the done.state
 * it caused (SPEC-010, #520).
 *
 * `internalEventsPending` says whether to look at the instance row first. Only
 * the worker's own archive calls write the internal queue (it holds the
 * instance's lock), so it is true when the worker starts (a crash may have
 * left events there) and afterwards whatever the last archive result said.
 * Returns null when there is no event.
 */
export async function takeNextEvent<
  I extends { fsm_instance_row: FsmInstanceRow },
>(
  internalEventsPending: boolean,
  readInstance: () => Promise<I | null>,
  readQueueMessage: () => Promise<MessageRecord | undefined>,
): Promise<{ next: NextEvent; instance: I } | null> {
  if (internalEventsPending) {
    const instance = await readInstance();
    const event = nextInternalEvent(instance?.fsm_instance_row);
    if (instance && event !== null) {
      return {
        next: {
          source: "internal",
          event,
          msg: internalEventMessage(event, instance.fsm_instance_row),
        },
        instance,
      };
    }
  }
  const msg = await readQueueMessage();
  if (!msg?.message || msg.msg_id === null || msg.msg_id === undefined) {
    return null;
  }
  const instance = await readInstance();
  return instance ? { next: { source: "queue", msg }, instance } : null;
}
