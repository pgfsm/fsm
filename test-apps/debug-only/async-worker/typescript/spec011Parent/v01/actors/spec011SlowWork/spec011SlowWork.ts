// Actor: spec011SlowWork — SPEC-011's end-to-end test (#536). Runs for 3s,
// so spec011Parent's 1s timer exits the Slow state first: this result arrives
// late and must be dropped, not sent to the parent.

// How many invokes of this actor one worker runs at once. Above 1, the
// handler must be safe to run concurrently (no unguarded shared state, only
// concurrency-safe clients). Delivery is at-least-once, so the handler must
// also be idempotent: the same invoke can arrive more than once.
export const maxConcurrency = 2;

export async function spec011SlowWork(_input: unknown): Promise<unknown> {
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  return { slow: "finished" };
}
