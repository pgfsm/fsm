import { createMachine } from "xstate";

// The child FSM spec013Input invokes in SPEC-013's end-to-end test (#587).
// Its static context is the declared default an instance starts from, with
// the invoke's input merged over it.
export const machine = createMachine({
  id: "spec013Child",
  initial: "Waiting",
  context: { tries: 0, ssn: "" },
  states: {
    Waiting: {},
  },
});

export default machine;
