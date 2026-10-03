// Actor: checkBureau

// How many invokes of this actor one worker runs at once. Above 1, the
// handler must be safe to run concurrently (no unguarded shared state, only
// concurrency-safe clients). Delivery is at-least-once, so the handler must
// also be idempotent: the same invoke can arrive more than once.
export const maxConcurrency = 5;

export function checkBureau(input: unknown): unknown {
  // TODO: implement actor logic
  return { input, msg: "checkBureau actor invoked by typescript" };
}
