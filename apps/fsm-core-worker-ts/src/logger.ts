import {
  CATEGORY,
  configureLogging,
  isTerminal,
  type LogLevel,
} from "@pgfsm/logging";

export type { LogLevel };

// Composition root for the worker CLIs: configures LogTape once. On a TTY it
// runs at debug for the rich summary view; piped output stays at the given
// level. Surfaces the worker/fsmlet/compiler namespaces this process hosts —
// add CATEGORY.db here to also see DB-layer logs.
export async function configureWorkerLogger(
  level: LogLevel = "info",
): Promise<void> {
  const lowestLevel = isTerminal ? "debug" : level;
  await configureLogging({
    levels: {
      [CATEGORY.worker]: lowestLevel,
      [CATEGORY.fsmlet]: lowestLevel,
      [CATEGORY.compiler]: lowestLevel,
    },
  });
}
