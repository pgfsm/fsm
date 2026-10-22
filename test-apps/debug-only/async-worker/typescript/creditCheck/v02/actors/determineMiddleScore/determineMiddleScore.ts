// Actor: determineMiddleScore

// How many invokes of this actor one worker runs at once. Above 1, the
// handler must be safe to run concurrently (no unguarded shared state, only
// concurrency-safe clients). Delivery is at-least-once, so the handler must
// also be idempotent: the same invoke can arrive more than once.
export const maxConcurrency = 1;

export function determineMiddleScore(
  input: unknown,
  signal: AbortSignal,
): unknown {
  // TODO: implement actor logic
  // signal aborts when the gateway cancels this invoke (e.g. its FSM state
  // exited): pass it to fetch() and the like, or check signal.aborted.
  return { input, msg: "determineMiddleScore actor invoked by typescript" };
}
