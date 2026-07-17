import {
  CATEGORY,
  configureLogging,
  isTerminal,
  type LogLevel,
} from "@pgfsm/logging";

export type { LogLevel };

// Composition root for the worker CLIs: configures LogTape once. On a TTY it
// runs at debug for the rich summary view; piped output stays at the given
// level. Surfaces the worker/fsmlet/db/compiler namespaces this process
// hosts — CATEGORY.db is required so errors from the DB layer (e.g. reading
// from a queue that doesn't exist) aren't silently dropped by LogTape.
export async function configureWorkerLogger(
  level: LogLevel = "info",
): Promise<void> {
  const lowestLevel = isTerminal ? "debug" : level;
  await configureLogging({
    levels: {
      [CATEGORY.worker]: lowestLevel,
      [CATEGORY.fsmlet]: lowestLevel,
      [CATEGORY.db]: lowestLevel,
      [CATEGORY.compiler]: lowestLevel,
      [CATEGORY.scheduler]: lowestLevel,
    },
  });
}
