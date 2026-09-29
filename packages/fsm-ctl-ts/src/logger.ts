import {
  CATEGORY,
  configureLogging,
  isTerminal,
  type LogLevel,
} from "@pgfsm/logging";

export type { LogLevel };

/** LogTape category for pgfsmctl's own messages. */
export const CTL_CATEGORY = "@pgfsm/ctl";

// Composition root for pgfsmctl (ADR-001): configures LogTape once. On a TTY
// it runs at debug for the rich summary view; piped output stays at the
// given level. CATEGORY.db is required so errors from the DB layer aren't
// silently dropped; CATEGORY.scheduler covers `scheduler run`.
export async function configureCtlLogger(
  level: LogLevel = "info",
): Promise<void> {
  const lowestLevel = isTerminal ? "debug" : level;
  await configureLogging({
    levels: {
      [CTL_CATEGORY]: lowestLevel,
      [CATEGORY.db]: lowestLevel,
      [CATEGORY.scheduler]: lowestLevel,
    },
  });
}
