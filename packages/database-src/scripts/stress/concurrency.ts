/**
 * Runs `tasks` with at most `limit` in flight at once, preserving result
 * order. Small and local on purpose — the harness has no other need for a
 * general-purpose concurrency-limiting dependency.
 */
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

/**
 * Repeatedly invokes `task` from `concurrency` parallel loops until
 * `durationMs` has elapsed. Used by the poller-style scenarios
 * (claim contention, macrostep throughput) where "how many calls fit in a
 * fixed window" is the thing being measured, rather than "how long does a
 * fixed count take."
 */
export async function runForDuration(
  task: () => Promise<void>,
  concurrency: number,
  durationMs: number,
): Promise<void> {
  const deadline = Date.now() + durationMs;

  async function loop() {
    while (Date.now() < deadline) {
      await task();
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => loop()));
}
