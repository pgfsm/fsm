// Opt-in helpers for attaching a value to a log record so the console sink can
// render it in the most readable shape (table / dir / log). Each returns a
// LogTape *properties* object, so it slots straight into the second argument of
// logger.info(message, properties):
//
//   logger.info("Database config", table(config));
//   logger.info("Incoming request", dir(request));
//   logger.info("Results", inspect(rows, ["id", "name"]));
//
// The sink never auto-renders arbitrary properties — data is only rendered when
// attached through one of these helpers, keeping normal structured fields out
// of the table/dir path.

// Marker property key holding the render payload. Deliberately obscure so it
// won't collide with a real structured-logging field.
export const RENDER_KEY = "__pgfsmRender";

// How the sink should render the attached value:
//  - "table": force console.table (arrays -> rows; flat objects -> key/value).
//  - "dir":   force console.dir with full depth (nested objects).
//  - "auto":  let the sink decide from the value's shape (see the sink).
export type RenderMode = "auto" | "table" | "dir";

export interface RenderPayload {
  value: unknown;
  // Restrict which columns a table shows: console.table's 2nd arg for arrays,
  // or a key allow-list for flat objects. Ignored by dir.
  columns?: readonly string[];
  mode: RenderMode;
}

function payload(
  value: unknown,
  mode: RenderMode,
  columns?: readonly string[],
): Record<string, RenderPayload> {
  return { [RENDER_KEY]: { value, mode, columns } };
}

// Force table rendering. A flat object prints as key/value rows; an array
// prints one row per element. Use `columns` to narrow what's shown.
export function table(
  value: unknown,
  columns?: readonly string[],
): Record<string, RenderPayload> {
  return payload(value, "table", columns);
}

// Force console.dir with full depth — best for nested objects you want to
// inspect without losing structure (which console.table would flatten away).
export function dir(value: unknown): Record<string, RenderPayload> {
  return payload(value, "dir");
}

// Let the sink pick the shape: arrays and flat objects become tables, nested
// objects go to dir, primitives to log.
export function inspect(
  value: unknown,
  columns?: readonly string[],
): Record<string, RenderPayload> {
  return payload(value, "auto", columns);
}

function isPrimitiveLike(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  );
}

// True when every own value is a primitive — safe to flatten into a key/value
// table without losing nested information. A nested object fails this check and
// is routed to console.dir instead.
export function isFlatObject(value: object): boolean {
  return Object.values(value).every(isPrimitiveLike);
}
