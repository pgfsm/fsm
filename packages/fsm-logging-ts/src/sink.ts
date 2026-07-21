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
export const isTerminal: boolean = typeof Deno !== "undefined"
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

function isPrimitive(v: unknown): boolean {
  return v === null || (typeof v !== "object" && typeof v !== "function");
}

// Property names referenced as `{placeholder}` in a string message template, so
// the sink can skip properties already interpolated into the message line
// (e.g. `{error}` in "failed: {error}"). LogTape looks up the whole trimmed
// placeholder text as a property key, so we match that verbatim. Tagged-
// template rawMessage has no named placeholders — nothing to skip.
function interpolatedKeys(
  rawMessage: string | TemplateStringsArray,
): Set<string> {
  if (typeof rawMessage !== "string") return new Set();
  const keys = new Set<string>();
  for (const match of rawMessage.matchAll(/\{([^{}]+)\}/g)) {
    keys.add(match[1].trim());
  }
  return keys;
}

// A console sink that prints the formatted message line for every record, then
// renders attached data in the most readable shape beneath it:
//
//  - Explicit: a value attached via table()/dir()/inspect() (the RENDER_KEY
//    payload) is rendered in the requested/auto mode.
//  - Auto: any *extra* property — one whose value is a non-primitive (array or
//    object) and that was NOT interpolated into the message template — is
//    rendered with its key as a label, using the same shape decision as
//    inspect(). This lets you write `logger.info("Results ({n}):", { n, rows })`
//    and get a table for `rows` without wrapping it in a helper. Scalars are
//    left to the message template (show them via `{placeholder}`).
//
// Both are TTY-only. On a non-TTY the explicit payload is emitted as a single
// JSON line (greppable); extra properties stay in the record for structured
// sinks (OTel/files) and are not echoed.
export function getTableConsoleSink(): Sink {
  return (record: LogRecord) => {
    console.log(formatLine(record));

    const props = record.properties;
    if (!props) return;

    const payload = props[RENDER_KEY] as RenderPayload | undefined;
    if (payload) {
      if (isTerminal) renderPayload(payload);
      else console.log(JSON.stringify(payload.value));
    }

    if (!isTerminal) return;
    const interpolated = interpolatedKeys(record.rawMessage);
    for (const [key, value] of Object.entries(props)) {
      if (key === RENDER_KEY || interpolated.has(key) || isPrimitive(value)) {
        continue;
      }
      console.log(key);
      renderAuto(value);
    }
  };
}
