// Actor: spec011RetryWork — SPEC-011's end-to-end test (#536). The first
// invoke in this worker runs for 1.5s, every later one for 3s, and each
// returns which invoke it was. spec011Parent re-enters its Retrying state
// about 0.5s into the first, so the first's result arrives while the parent
// waits in the re-entered state for the second: it must be dropped, not taken
// for the second's (same invoke id). The count is per worker process, which
// is what the test runs.

// How many invokes of this actor one worker runs at once. Above 1, the
// handler must be safe to run concurrently (no unguarded shared state, only
// concurrency-safe clients). Delivery is at-least-once, so the handler must
// also be idempotent: the same invoke can arrive more than once.
export const maxConcurrency = 2;

let invokes = 0;

export async function spec011RetryWork(_input: unknown): Promise<unknown> {
  const invoke = ++invokes;
  await new Promise((resolve) =>
    setTimeout(resolve, invoke === 1 ? 1_500 : 3_000)
  );
  return { invoke };
}
