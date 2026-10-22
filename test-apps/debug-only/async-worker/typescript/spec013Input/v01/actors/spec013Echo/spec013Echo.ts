// Actor: spec013Echo — SPEC-013's end-to-end test (#587). Returns the input
// it was invoked with, so the test can see exactly what the actor received.

// How many invokes of this actor one worker runs at once.
export const maxConcurrency = 4;

export function spec013Echo(input: unknown, _signal: AbortSignal): unknown {
  return { received: input };
}
