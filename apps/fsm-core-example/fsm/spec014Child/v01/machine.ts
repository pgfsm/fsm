import { createMachine } from "xstate";

// The child FSM spec014Error invokes in SPEC-014's end-to-end test (#620). Its
// initial state's entry action always throws, so the instance ends in status
// error; the test runs it with maxAttempts 1, and its parent's onError takes
// the error.
export const machine = createMachine({
  id: "spec014Child",
  initial: "Working",
  states: {
    Working: {
      entry: [{ type: "spec014AlwaysThrowsAction" }],
    },
  },
});

export default machine;
