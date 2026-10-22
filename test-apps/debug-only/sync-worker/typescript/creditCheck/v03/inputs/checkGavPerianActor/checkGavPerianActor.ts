// Input: checkGavPerianActor
// Builds this invoke's input when it starts (SPEC-013): the sync worker calls
// it with the instance's context and the event that entered the state, and
// the actor receives what it returns (JSON). For an invoked child FSM, return
// an object: it's merged over the child's declared context.
// Copied from machine.ts's input function when this stub was created. It's
// yours now: edits to machine.ts don't update it.
export function checkGavPerianActor(context: any, event: any): unknown {
  const input: (args: { context: any; event: any }) => unknown = (
    { context: { SSN } },
  ) => ({
    ssn: SSN,
    bureauName: "Gavperian",
  });
  return input({ context, event });
}
