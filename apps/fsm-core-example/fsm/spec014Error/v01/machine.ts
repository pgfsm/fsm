import { createMachine } from "xstate";

// SPEC-014's end-to-end test machine (#620), driven by
// spec014-journey-test.ts. Each scenario starts a new instance in Idle:
//
// FLAKY then NEXT   spec014FlakyOnce throws on its first attempt for a
//                   message, then passes. The worker retries FLAKY in place,
//                   so NEXT can only arrive in AfterFlaky: ending in Ordered
//                   shows the events kept their order.
// BROKEN            spec014AlwaysThrows always throws: the instance ends in
//                   status error, still in Idle.
// START_CHILD       invokes spec014Child, which ends in error; onError takes
//                   it to ChildFailed.
export const machine = createMachine({
  id: "spec014Error",
  initial: "Idle",
  states: {
    Idle: {
      on: {
        FLAKY: { target: "AfterFlaky", guard: "spec014FlakyOnce" },
        BROKEN: { target: "Unreachable", guard: "spec014AlwaysThrows" },
        START_CHILD: "WithChild",
      },
    },
    AfterFlaky: {
      on: { NEXT: "Ordered" },
    },
    Ordered: {},
    Unreachable: {},
    WithChild: {
      invoke: {
        asyncOperationType: "fsm",
        asyncOperationVersion: "v01",
        src: "spec014Child",
        onError: "ChildFailed",
      },
    },
    ChildFailed: {},
  },
});

export default machine;
