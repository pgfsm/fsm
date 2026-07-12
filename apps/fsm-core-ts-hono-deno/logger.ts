import { CATEGORY, configureLogging, type LogLevel } from "@pgfsm/logging";
import env from "./env.ts";

export type { LogLevel };

// Composition root for the API process: resolves levels from the validated env
// (per-category overrides falling back to LOG_LEVEL) and configures LogTape
// once. The API process also hosts db/worker/compiler code, so it surfaces
// those categories too.
export async function configureApiLogger(): Promise<void> {
  const defaultLevel = env!.LOG_LEVEL as LogLevel;
  const otelEnabled = env!.OTEL_DENO === "true" &&
    !!env!.OTEL_EXPORTER_OTLP_ENDPOINT;

  await configureLogging({
    levels: {
      [CATEGORY.api]: (env!.LOG_LEVEL_API ?? defaultLevel) as LogLevel,
      [CATEGORY.worker]: (env!.LOG_LEVEL_WORKER ?? defaultLevel) as LogLevel,
      [CATEGORY.compiler]:
        (env!.LOG_LEVEL_COMPILER ?? defaultLevel) as LogLevel,
      [CATEGORY.db]: (env!.LOG_LEVEL_DB ?? defaultLevel) as LogLevel,
    },
    otel: otelEnabled,
  });
}
