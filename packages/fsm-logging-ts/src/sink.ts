import {
  getAnsiColorFormatter,
  getTextFormatter,
  type LogRecord,
  type Sink,
  type TextFormatter,
} from "@logtape/logtape";
import { isFlatObject, RENDER_KEY, type RenderPayload } from "./render.ts";

// True when stdout is an interactive TTY (Deno first, Node fallback). Gates the
// rich table/dir rendering below — those are for humans at a terminal; piped
// output falls back to a single greppable line.
export const isTerminal = typeof Deno !== "undefined"
  ? Deno.stdout.isTerminal()
  : typeof process !== "undefined" && !!process.stdout?.isTTY;

// The message line reuses LogTape's built-in formatters rather than a
// hand-rolled string: ANSI colours on a TTY, plain text otherwise. This is the
// "extend the default API" half — only the shape-based routing below needs a
// custom sink, because getConsoleSink can dispatch to console.log/info/warn/
// error but never to console.table or console.dir.
const formatLine: TextFormatter = isTerminal
  ? getAnsiColorFormatter()
  : getTextFormatter();

// Render an array or object as a console.table. Arrays table directly (columns
// select which fields show); objects flatten to key/value rows (columns act as
// a key allow-list). Primitives can't be tabled, so they fall back to log.
function renderTable(value: unknown, columns?: readonly string[]): void {
  if (Array.isArray(value)) {
    if (columns) console.table(value, columns as string[]);
    else console.table(value);
    return;
  }
  if (value !== null && typeof value === "object") {
    const rows = Object.entries(value)
      .filter(([key]) => !columns || columns.includes(key))
      .map(([key, val]) => ({ key, value: val }));
    console.table(rows);
    return;
  }
  console.log(value);
}

// Decision table (auto mode): arrays and flat objects -> console.table, nested
// objects -> console.dir(depth:null), primitives -> console.log.
function renderAuto(value: unknown, columns?: readonly string[]): void {
  if (Array.isArray(value)) {
    renderTable(value, columns);
    return;
  }
  if (value !== null && typeof value === "object") {
    if (isFlatObject(value)) renderTable(value, columns);
    else console.dir(value, { depth: null, colors: isTerminal });
    return;
  }
  console.log(value);
}

function renderPayload({ value, mode, columns }: RenderPayload): void {
  if (mode === "dir") {
    console.dir(value, { depth: null, colors: isTerminal });
    return;
  }
  if (mode === "table") {
    renderTable(value, columns);
    return;
  }
  renderAuto(value, columns);
}

// A console sink that prints the formatted message line for every record, then
// — when a value was attached via table()/dir()/inspect() — renders it in the
// most readable shape beneath the line. On a non-TTY the value is emitted as a
// single JSON line instead, so log files/aggregators stay greppable and lose
// nothing.
export function getTableConsoleSink(): Sink {
  return (record: LogRecord) => {
    console.log(formatLine(record));

    const payload = record.properties?.[RENDER_KEY] as
      | RenderPayload
      | undefined;
    if (!payload) return;

    if (isTerminal) renderPayload(payload);
    else console.log(JSON.stringify(payload.value));
  };
}
