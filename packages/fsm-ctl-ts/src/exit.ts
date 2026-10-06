// Exit codes (SPEC-009 §6, dbosctl's table plus 5). Commands throw a
// CtlError; the entry point turns it (or any other error) into one of these.
export const ExitCode = {
  OK: 0,
  /** DB/API unreachable, server error, anything unexpected. */
  GENERAL: 1,
  /** Bad flags or arguments, unknown noun/verb, unsupported tier. */
  USAGE: 2,
  /** Authentication or authorization failed (401/403, SQLSTATE 42501/28xxx). */
  AUTH: 3,
  /** Unknown FSM, instance, key or profile. */
  NOT_FOUND: 4,
  /** A status or check command ran and found a problem. */
  CHECK_FAILED: 5,
  /** Ctrl-C. */
  INTERRUPTED: 130,
} as const;

export type ExitCode = typeof ExitCode[keyof typeof ExitCode];

/**
 * An expected failure with its exit code and a message for the user. Thrown
 * by commands instead of calling Deno.exit, so the entry point owns exits.
 */
export class CtlError extends Error {
  constructor(
    readonly code: ExitCode,
    message: string,
    /** Printed after the message, e.g. the command's help on a usage error. */
    readonly hint?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CtlError";
  }
}

export const usageError = (message: string, help?: string) =>
  new CtlError(ExitCode.USAGE, message, help);

export const notFound = (message: string) =>
  new CtlError(ExitCode.NOT_FOUND, message);

/** The Postgres SQLSTATE on an error or anywhere in its cause chain. */
export function sqlState(err: unknown): string | undefined {
  for (let e = err; e && typeof e === "object"; e = (e as Error).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

/** The exit code for an error a command threw. */
export function exitCodeFor(err: unknown): ExitCode {
  if (err instanceof CtlError) return err.code;
  const state = sqlState(err);
  // 42501 insufficient_privilege; 28xxx invalid authorization (bad password,
  // unknown role).
  if (state === "42501" || state?.startsWith("28")) return ExitCode.AUTH;
  return ExitCode.GENERAL;
}
