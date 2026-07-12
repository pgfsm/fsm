// @pgfsm/logging — shared logging foundation (leaf package, no internal deps).
//
// Applications/CLIs call configureLogging() ONCE at their entry point, passing
// explicit levels resolved from their own validated env. Libraries only import
// CATEGORY + getLogger (from @logtape/logtape) — never configureLogging().
export { configureLogging, type ConfigureLoggingOptions } from "./configure.ts";
export { CATEGORY, type Category } from "./categories.ts";
export { getTableConsoleSink, isTerminal } from "./sink.ts";
// Opt-in render helpers: attach a value to a log record so the console sink
// prints it as a table / dir / log line. See render.ts for the decision table.
export {
  dir,
  inspect,
  isFlatObject,
  RENDER_KEY,
  type RenderMode,
  type RenderPayload,
  table,
} from "./render.ts";
export type { LogLevel } from "./types.ts";
