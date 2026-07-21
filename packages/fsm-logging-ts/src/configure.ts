import { configure, type Sink } from "@logtape/logtape";
// import { getConsoleSink } from "@logtape/logtape"; --- IGNORE ---
import { getOpenTelemetrySink } from "@logtape/otel";
import { getTableConsoleSink } from "./sink.ts";
import type { LogLevel } from "./types.ts";

export interface ConfigureLoggingOptions {
  // Lowest level to surface per category, keyed by the full category string
  // (use CATEGORY.*). Only listed categories are configured. "silent" routes
  // the category to a noop sink so nothing is emitted.
  levels: Record<string, LogLevel>;
  // Enable the OpenTelemetry sink alongside the console sink. The OTLP endpoint
  // itself is read by the OTel SDK from OTEL_EXPORTER_OTLP_ENDPOINT.
  otel?: boolean;
  // Level for LogTape's own meta logger (its internal diagnostics). Default "warning".
  metaLevel?: Exclude<LogLevel, "silent">;
}

type ActiveLevel = "debug" | "info" | "warning" | "error" | "fatal";

// "silent" maps to a noop sink at the highest active level so nothing is
// emitted; all other levels pass through to the active sinks.
function makeLoggerEntry(
  category: string,
  level: LogLevel,
  activeSinks: string[],
) {
  if (level === "silent") {
    return {
      category: [category],
      lowestLevel: "fatal" as const,
      sinks: ["noop"],
    };
  }
  return {
    category: [category],
    lowestLevel: level as ActiveLevel,
    sinks: activeSinks,
  };
}

// The single, process-wide LogTape configurator. Call this EXACTLY ONCE per
// process, at the application/CLI entry point. Libraries must never call it —
// they only getLogger(). The caller (composition root) resolves config from its
// own validated env and passes explicit levels here.
export async function configureLogging(
  opts: ConfigureLoggingOptions,
): Promise<void> {
  const otelEnabled = opts.otel === true;
  const activeSinks = otelEnabled ? ["console", "otel"] : ["console"];

  const sinks: Record<string, Sink> = {
    console: getTableConsoleSink(),
    // console: getConsoleSink(), --- IGNORE ---
    noop: () => {},
  };
  if (otelEnabled) sinks.otel = getOpenTelemetrySink();

  const metaLogger = {
    category: ["logtape", "meta"],
    lowestLevel: (opts.metaLevel ?? "warning") as ActiveLevel,
    sinks: ["console"],
  };

  await configure({
    sinks,
    loggers: [
      ...Object.entries(opts.levels).map(([category, level]) =>
        makeLoggerEntry(category, level, activeSinks)
      ),
      metaLogger,
    ],
  });
}
