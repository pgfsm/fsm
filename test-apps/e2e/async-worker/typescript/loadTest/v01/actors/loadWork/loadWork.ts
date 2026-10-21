// Actor: loadWork — the SPEC-007 acceptance suite's load (#458). Sleeps for
// `workMs`, then reports which worker processed the message, so the suite can
// tell replicas apart (`worker` is the pod name in Kubernetes).

// How many invokes of this actor one worker runs at once. Above 1, the
// handler must be safe to run concurrently (no unguarded shared state, only
// concurrency-safe clients). Delivery is at-least-once, so the handler must
// also be idempotent: the same invoke can arrive more than once.
export const maxConcurrency = 1;

const MAX_WORK_MS = 600_000;

export async function loadWork(
  input: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const { n, runId, workMs } = (input ?? {}) as {
    n?: number;
    runId?: string;
    workMs?: number;
  };
  const ms = Math.min(Math.max(Number(workMs) || 0, 0), MAX_WORK_MS);
  // The work stops when the gateway cancels this invoke (SPEC-012).
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
  return { n, runId, worker: Deno.hostname(), language: "typescript" };
}
