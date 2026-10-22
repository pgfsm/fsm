import { createMachine } from "xstate";

// SPEC-012's end-to-end test machine (#545), driven by
// spec012-journey-test.ts. Each START_<LANG> enters a state that invokes that
// language's actor, which works for 5s; the state's 1.5s timer exits it
// first, so the gateway cancels the running handler. The actor checks its
// cancellation token and stops before its side effect (writing a marker file
// at the input's markerPath). The instance must end in Abandoned and never
// reach Finished.
export const machine = createMachine({
  id: "spec012Cancel",
  initial: "Idle",
  context: { markerPath: "" },
  states: {
    Idle: {
      on: {
        START_TS: "WorkTs",
        START_PY: "WorkPy",
        START_RS: "WorkRs",
        START_GO: "WorkGo",
      },
    },
    WorkTs: {
      invoke: {
        id: "workTs",
        src: "spec012WorkTs",
        asyncOperationLanguage: "typescript",
        input: ({ context }: { context: { markerPath: string } }) => ({
          markerPath: context.markerPath,
        }),
        onDone: "Finished",
      },
      after: { 1500: "Abandoned" },
    },
    WorkPy: {
      invoke: {
        id: "workPy",
        src: "spec012WorkPy",
        asyncOperationLanguage: "python",
        input: ({ context }: { context: { markerPath: string } }) => ({
          markerPath: context.markerPath,
        }),
        onDone: "Finished",
      },
      after: { 1500: "Abandoned" },
    },
    WorkRs: {
      invoke: {
        id: "workRs",
        src: "spec012WorkRs",
        asyncOperationLanguage: "rust",
        input: ({ context }: { context: { markerPath: string } }) => ({
          markerPath: context.markerPath,
        }),
        onDone: "Finished",
      },
      after: { 1500: "Abandoned" },
    },
    WorkGo: {
      invoke: {
        id: "workGo",
        src: "spec012WorkGo",
        asyncOperationLanguage: "go",
        input: ({ context }: { context: { markerPath: string } }) => ({
          markerPath: context.markerPath,
        }),
        onDone: "Finished",
      },
      after: { 1500: "Abandoned" },
    },
    Finished: {},
    Abandoned: {},
  },
});

export default machine;
