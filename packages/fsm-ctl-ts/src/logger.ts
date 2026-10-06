import { CATEGORY, configureLogging, type LogLevel } from "@pgfsm/logging";

export type { LogLevel };

/** LogTape category for pgfsmctl's own messages. */
export const CTL_CATEGORY = "@pgfsm/ctl";

// Composition root for pgfsmctl (ADR-001): configures LogTape once. Every
// log line goes to stderr (consoleStream "stderr"): stdout carries only
// command output, so `-o json` pipes cleanly (SPEC-009 §6). CATEGORY.db is
// required so errors from the DB layer aren't silently dropped;
// CATEGORY.scheduler covers `scheduler run`. $PGFSMCTL_LOG_LEVEL overrides
// the level (e.g. debug, to see which database target was picked).
export async function configureCtlLogger(
  level: LogLevel = "info",
): Promise<void> {
  const lowestLevel = (Deno.env.get("PGFSMCTL_LOG_LEVEL") as LogLevel) ??
    level;
  await configureLogging({
    consoleStream: "stderr",
    levels: {
      [CTL_CATEGORY]: lowestLevel,
      [CATEGORY.db]: lowestLevel,
      [CATEGORY.scheduler]: lowestLevel,
    },
  });
}
