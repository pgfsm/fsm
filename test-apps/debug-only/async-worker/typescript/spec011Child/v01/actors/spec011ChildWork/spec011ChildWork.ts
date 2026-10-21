// Actor: spec011ChildWork — SPEC-011's end-to-end test (#536). Runs for 10s,
// so spec011Parent's 2s timer always exits the invoking state while it runs:
// the parent stops the child, and this message is cancelled while in flight.

// How many invokes of this actor one worker runs at once. Above 1, the
// handler must be safe to run concurrently (no unguarded shared state, only
// concurrency-safe clients). Delivery is at-least-once, so the handler must
// also be idempotent: the same invoke can arrive more than once.
export const maxConcurrency = 2;

export async function spec011ChildWork(_input: unknown): Promise<unknown> {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  return { child: "finished" };
}
