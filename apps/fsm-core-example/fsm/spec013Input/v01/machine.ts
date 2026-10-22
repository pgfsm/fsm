import { createMachine } from "xstate";

// SPEC-013's end-to-end test machine (#587), driven by
// spec013-journey-test.ts. START runs three invokes in turn:
//
// Mapped     an input function over the instance's context and the event
//            that entered the state; the echo actor returns its input, which
//            saveMapped keeps in context.
// Fixed      a static input, the same for every instance.
// WithChild  an invoked child FSM whose input is merged over its declared
//            context.
//
// In this runtime an event's fields are under `event.eventPayload`.
export const machine = createMachine({
  id: "spec013Input",
  initial: "Idle",
  context: { ssn: "", mapped: null, fixed: null },
  states: {
    Idle: {
      on: { START: "Mapped" },
    },
    Mapped: {
      invoke: {
        id: "mappedEcho",
        src: "spec013Echo",
        input: ({ context, event }: {
          context: { ssn: string };
          event: { eventPayload?: { requestId?: string } };
        }) => ({
          bureauName: "EquiGavin",
          ssn: context.ssn,
          requestId: event?.eventPayload?.requestId ?? null,
        }),
        onDone: { target: "Fixed", actions: [{ type: "saveMapped" }] },
      },
    },
    Fixed: {
      invoke: {
        src: "spec013Echo",
        input: { bureauName: "GavUnion" },
        onDone: { target: "WithChild", actions: [{ type: "saveFixed" }] },
      },
    },
    WithChild: {
      invoke: {
        asyncOperationType: "fsm",
        asyncOperationVersion: "v01",
        src: "spec013Child",
        input: ({ context }: { context: { ssn: string } }) => ({
          ssn: context.ssn,
        }),
      },
    },
  },
});

export default machine;
