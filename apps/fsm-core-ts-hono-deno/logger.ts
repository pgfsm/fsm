import {
  configure,
  getConsoleSink,
  type LogRecord,
  type Sink,
} from "@logtape/logtape";
import { getOpenTelemetrySink } from "@logtape/otel";
// import { AsyncLocalStorage } from "node:async_hooks";
import env from "./env.ts";

const isTerminal = typeof Deno !== "undefined"
  ? Deno.stdout.isTerminal()
  : typeof process !== "undefined" && !!process.stdout?.isTTY;

function renderMessage(record: LogRecord): string {
  return record.message
    .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
    .join("");
}

function getSummaryConsoleSink(): Sink {
  return (record: LogRecord) => {
    if (record.category.length > 2 && record.level === "debug") {
      const parentGroup = record.category.slice(0, 2).join(" > ");
      if (typeof process !== "undefined" && process.stdout?.write) {
        process.stdout.write(`\r 📂 [${parentGroup}] Processing inner tasks...    `);
      } else {
        console.log(`📂 [${parentGroup}] Tasks working...`);
      }
    } else {
      if (isTerminal) process.stdout?.write("\r\x1b[K");
      console.log(`✨ [${record.category.join(".")}] ${renderMessage(record)}`);
    }
  };
}

export type LogLevel = "debug" | "info" | "warning" | "error" | "fatal" | "silent";
type ActiveLevel = "debug" | "info" | "warning" | "error" | "fatal";

// "silent" maps to a noop sink at the highest active level so nothing is emitted.
// All other levels pass through to the provided active sinks.
function makeLoggerEntry(category: string[], level: LogLevel, activeSinks: string[]) {
  if (level === "silent") {
    return { category, lowestLevel: "fatal" as const, sinks: ["noop"] };
  }
  return { category, lowestLevel: level as ActiveLevel, sinks: activeSinks };
}

export async function configureApiLogger(): Promise<void> {
  const defaultLevel = env!.LOG_LEVEL as LogLevel;
  const levels = {
    api:      (env!.LOG_LEVEL_API      ?? defaultLevel) as LogLevel,
    worker:   (env!.LOG_LEVEL_WORKER   ?? defaultLevel) as LogLevel,
    compiler: (env!.LOG_LEVEL_COMPILER ?? defaultLevel) as LogLevel,
    db:       (env!.LOG_LEVEL_DB       ?? defaultLevel) as LogLevel,
  };

  const metaLogger = { category: ["logtape", "meta"], sinks: ["console"] as string[], lowestLevel: "warning" as const };
  const consoleSink = isTerminal ? getSummaryConsoleSink() : getConsoleSink();
  const noopSink: Sink = () => {};

  const otlpEndpoint = env!.OTEL_EXPORTER_OTLP_ENDPOINT;
  const otelEnabled = env!.OTEL_DENO === "true" && !!otlpEndpoint;
  const activeSinks = otelEnabled ? ["console", "otel"] : ["console"];
  const sinks: Record<string, Sink> = { console: consoleSink, noop: noopSink };
  if (otelEnabled) sinks.otel = getOpenTelemetrySink();

  await configure({
    // contextLocalStorage: new AsyncLocalStorage(),
    sinks,
    loggers: [
      makeLoggerEntry(["@pgfsm/api"],      levels.api,      activeSinks),
      makeLoggerEntry(["@pgfsm/worker"],   levels.worker,   activeSinks),
      makeLoggerEntry(["@pgfsm/compiler"], levels.compiler, activeSinks),
      makeLoggerEntry(["@pgfsm/db"],       levels.db,       activeSinks),
      metaLogger,
    ],
  });
}
