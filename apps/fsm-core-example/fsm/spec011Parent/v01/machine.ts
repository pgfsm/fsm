import { createMachine } from "xstate";

// SPEC-011's end-to-end test machine (#536), driven by
// spec011-journey-test.ts. One state per scenario; each starts from Idle on
// its own event. The end states are not final, so the instance stays active
// and a result that should be dropped would still be processed if it got
// through.
//
// A  WithChild: invokes the child FSM spec011Child, whose actor runs for
//    10s; the 2s timer exits the state first, which must stop the child and
//    its actor (stop_child_fsm_v2), and the parent must get no done event.
// B  Slow: invokes an actor that runs for 3s; the 1s timer exits the state
//    first, so the actor's late result must be dropped
//    (finish_async_operation_event_v2's archive gate).
// C  Retrying: RETRY re-enters the state while the first invoke (1.5s) is
//    still running. The first's result arrives while the re-entered state
//    waits for the second (3s), under the same invoke id: it must be dropped,
//    and the second's must be the one that finishes the state.
export const machine = createMachine({
  id: "spec011Parent",
  initial: "Idle",
  context: { result: null },
  states: {
    Idle: {
      on: {
        START_CHILD: "WithChild",
        START_SLOW: "Slow",
        START_RETRY: "Retrying",
      },
    },

    WithChild: {
      invoke: {
        asyncOperationType: "fsm",
        asyncOperationVersion: "v01",
        src: "spec011Child",
        onDone: "ChildDone",
      },
      after: {
        2000: "ChildAbandoned",
      },
    },
    ChildDone: {},
    ChildAbandoned: {},

    Slow: {
      invoke: {
        src: "spec011SlowWork",
        onDone: "SlowDone",
      },
      after: {
        1000: "TimedOut",
      },
    },
    SlowDone: {},
    TimedOut: {},

    Retrying: {
      invoke: {
        src: "spec011RetryWork",
        onDone: {
          target: "RetryDone",
          actions: [{ type: "saveResult" }],
        },
      },
      on: {
        RETRY: {
          target: "Retrying",
          reenter: true,
        },
      },
    },
    RetryDone: {},
  },
});

export default machine;
