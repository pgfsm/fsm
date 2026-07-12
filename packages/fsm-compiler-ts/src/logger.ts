import {
  CATEGORY,
  configureLogging,
  isTerminal,
  type LogLevel,
} from "@pgfsm/logging";

export type { LogLevel };

// Composition root for the compiler CLI and tests (each is its own process).
// The compiler is also imported as a library by the API/worker — those
// processes configure logging themselves, and this is NOT called on import.
export async function configureCompilerLogger(
  level: LogLevel = "info",
): Promise<void> {
  await configureLogging({
    levels: {
      [CATEGORY.compiler]: isTerminal ? "debug" : level,
    },
  });
}
