// SPEC-014's error policy for sync operations: what the worker does when a
// guard, action, delay function or input mapper throws.

/** The kinds of sync operation a step calls (SPEC-014). */
export type SyncOperationKind = "guard" | "action" | "delay" | "input";

/**
 * A throw from a sync operation, as opposed to a platform error (the database,
 * pgmq, the archive call). Only these count toward `maxAttempts`.
 */
export class SyncOperationError extends Error {
  constructor(
    readonly kind: SyncOperationKind,
    readonly operation: string,
    override readonly cause: unknown,
  ) {
    super(
      `${kind} ${operation} threw: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "SyncOperationError";
  }
}

/** Calls a sync operation, turning anything it throws into a SyncOperationError. */
export async function callSyncOperation<T>(
  kind: SyncOperationKind,
  operation: string,
  call: () => T | Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (cause) {
    throw new SyncOperationError(kind, operation, cause);
  }
}

/** `FsmletOptions.syncOperationRetry` (SPEC-014). */
export type SyncOperationRetryOptions = {
  /** Attempts per step for every FSM this fsmlet serves. Default 3. */
  maxAttempts?: number;
  /** Per FSM name (all its versions), overriding `maxAttempts`. */
  fsms?: Record<string, { maxAttempts: number }>;
};

export const DEFAULT_SYNC_OPERATION_MAX_ATTEMPTS = 3;

/** The longest wait between two attempts. */
export const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Throws, naming the bad value, unless every `maxAttempts` is an integer ≥ 1.
 * `startFsmlet` calls it before it connects.
 */
export function validateSyncOperationRetry(
  options: SyncOperationRetryOptions | undefined,
): void {
  const check = (where: string, value: unknown) => {
    if (!Number.isInteger(value) || (value as number) < 1) {
      throw new TypeError(
        `syncOperationRetry${where}.maxAttempts must be an integer ≥ 1, got ${
          JSON.stringify(value)
        }`,
      );
    }
  };
  if (options?.maxAttempts !== undefined) check("", options.maxAttempts);
  for (const [fsmName, fsm] of Object.entries(options?.fsms ?? {})) {
    check(`.fsms.${fsmName}`, fsm?.maxAttempts);
  }
}

/** The attempts a step of `fsmName` gets. */
export function maxAttemptsFor(
  options: SyncOperationRetryOptions | undefined,
  fsmName: string,
): number {
  return options?.fsms?.[fsmName]?.maxAttempts ?? options?.maxAttempts ??
    DEFAULT_SYNC_OPERATION_MAX_ATTEMPTS;
}

/**
 * The wait before the next attempt, after `failures` failed attempts in a row
 * (1 → 1 s, 2 → 2 s, doubling), capped at 30 s.
 */
export function retryDelayMs(failures: number): number {
  return Math.min(1000 * 2 ** (Math.max(failures, 1) - 1), MAX_RETRY_DELAY_MS);
}

/** The error saved with status `error` once a step runs out of attempts. */
export function syncOperationErrorRecord(
  error: SyncOperationError,
  attempts: number,
  eventType: string,
): {
  kind: SyncOperationKind;
  name: string;
  message: string;
  attempts: number;
  eventType: string;
} {
  const cause = error.cause;
  return {
    kind: error.kind,
    name: error.operation,
    message: cause instanceof Error ? cause.message : String(cause),
    attempts,
    eventType,
  };
}
