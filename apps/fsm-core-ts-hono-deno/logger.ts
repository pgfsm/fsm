import {
  configure,
  getConsoleSink,
  type LogRecord,
  type Sink,
} from "@logtape/logtape";

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

export type LogLevel = "debug" | "info" | "warning" | "error" | "fatal";

export async function configureApiLogger(
  level: LogLevel = "info",
): Promise<void> {
  const metaLogger = { category: ["logtape", "meta"], sinks: ["console"] as string[], lowestLevel: "warning" as const };

  if (isTerminal) {
    await configure({
      sinks: { console: getSummaryConsoleSink() },
      loggers: [
        { category: ["@pgfsm/api"], lowestLevel: "debug", sinks: ["console"] },
        metaLogger,
      ],
    });
    return;
  }

  await configure({
    sinks: { console: getConsoleSink() },
    loggers: [
      { category: ["@pgfsm/api"], lowestLevel: level, sinks: ["console"] },
      metaLogger,
    ],
  });
}
