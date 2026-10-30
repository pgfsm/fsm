import {
  retryDelayMs,
  SyncOperationError,
  syncOperationErrorRecord,
} from "./sync-operation-error.ts";

/** Waits `ms`, or less if `signal` aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export type StepRetry<T> = {
  /** Computes and saves the step; throws on any failure. */
  attemptStep: () => Promise<T>;
  /** Saves status error for a step that ran out of attempts; may throw. */
  saveError: (error: ReturnType<typeof syncOperationErrorRecord>) => Promise<T>;
  /** The number of the first attempt: a pgmq message's read_ct, else 1. */
  firstAttempt: number;
  maxAttempts: number;
  eventType: string;
  signal?: AbortSignal;
  onSyncOperationError?: (
    error: SyncOperationError,
    attempt: number,
    delayMs: number,
  ) => void;
  onPlatformError?: (error: unknown, delayMs: number) => void;
  /** Injected by tests. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export type StepRetryResult<T> =
  | { outcome: "saved"; result: T }
  | { outcome: "error_saved"; result: T }
  | { outcome: "aborted" };

/**
 * SPEC-014: runs a step until it's saved, retrying in place. A throw from a
 * sync operation counts toward `maxAttempts`, numbered from `firstAttempt`;
 * once they run out, `saveError` records status error. Any other error (the
 * database, pgmq, the archive) is a platform error: it's retried with the same
 * backoff, capped at 30 s, and never counts. Waits start at 1 s and double.
 * Nothing else is taken for the instance meanwhile, so its events stay in
 * order.
 */
export async function runStepWithRetry<T>(
  options: StepRetry<T>,
): Promise<StepRetryResult<T>> {
  const wait = options.wait ?? sleep;
  let attempt = Math.max(1, options.firstAttempt);
  let operationFailures = 0;
  let platformFailures = 0;
  // Set once the step has run out of attempts; from then on only the error is
  // saved (a platform error while saving it is retried like any other).
  let finalError: SyncOperationError | undefined;

  while (!options.signal?.aborted) {
    try {
      if (finalError) {
        return {
          outcome: "error_saved",
          result: await options.saveError(
            syncOperationErrorRecord(finalError, attempt, options.eventType),
          ),
        };
      }
      return { outcome: "saved", result: await options.attemptStep() };
    } catch (err) {
      if (err instanceof SyncOperationError && !finalError) {
        platformFailures = 0;
        if (attempt >= options.maxAttempts) {
          finalError = err;
          continue;
        }
        operationFailures++;
        const delayMs = retryDelayMs(operationFailures);
        options.onSyncOperationError?.(err, attempt, delayMs);
        attempt++;
        await wait(delayMs, options.signal);
      } else {
        platformFailures++;
        const delayMs = retryDelayMs(platformFailures);
        options.onPlatformError?.(err, delayMs);
        await wait(delayMs, options.signal);
      }
    }
  }
  return { outcome: "aborted" };
}
