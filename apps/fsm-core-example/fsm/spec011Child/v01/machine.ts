import { createMachine } from "xstate";

// The child FSM spec011Parent invokes in SPEC-011's end-to-end test (#536):
// its actor runs for 10s, so the parent's timer always exits the invoking
// state first and the child is stopped while its actor is running.
export const machine = createMachine({
  id: "spec011Child",
  initial: "Working",
  states: {
    Working: {
      invoke: {
        src: "spec011ChildWork",
        onDone: {
          target: "Finished",
          actions: [{ type: "markChildDone" }],
        },
      },
    },
    Finished: {
      type: "final",
    },
  },
});

export default machine;
