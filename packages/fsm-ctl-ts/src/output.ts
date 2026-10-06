import { usageError } from "./exit.ts";

// `-o table|json|ids` (SPEC-009 §6). Data goes to stdout through these
// helpers; logs go to stderr (the logger is configured with consoleStream
// "stderr"), so `pgfsmctl … -o json | jq` always gets clean JSON.

export const OUTPUT_FORMATS = ["table", "json", "ids"] as const;
export type OutputFormat = typeof OUTPUT_FORMATS[number];

export function parseOutputFormat(value: string | undefined): OutputFormat {
  const format = value ?? "table";
  if (!(OUTPUT_FORMATS as readonly string[]).includes(format)) {
    throw usageError(
      `-o/--output must be one of ${OUTPUT_FORMATS.join(", ")}, got: ${format}`,
    );
  }
  return format as OutputFormat;
}

type Row = Record<string, unknown>;

const cell = (v: unknown): string =>
  v === null || v === undefined
    ? ""
    : v instanceof Date
    ? v.toISOString()
    : typeof v === "object"
    ? JSON.stringify(v)
    : String(v);

const write = (text: string) => {
  if (text !== "") console.log(text);
};

/** A list: aligned columns, a JSON array, or one id per line. */
export function printList<T extends Row>(
  rows: T[],
  format: OutputFormat,
  options: { columns: (keyof T & string)[]; id: (row: T) => string },
): void {
  if (format === "json") return write(JSON.stringify(rows, null, 2));
  if (format === "ids") return write(rows.map(options.id).join("\n"));
  if (rows.length === 0) return;
  const { columns } = options;
  const table = [
    columns.map((c) => c.toUpperCase()),
    ...rows.map((r) => columns.map((c) => cell(r[c]))),
  ];
  const widths = columns.map((_, i) =>
    Math.max(...table.map((line) => line[i].length))
  );
  write(
    table.map((line) =>
      line.map((v, i) => i === line.length - 1 ? v : v.padEnd(widths[i]))
        .join("  ").trimEnd()
    ).join("\n"),
  );
}

/** One record: `key: value` lines, a JSON object, or its id. */
export function printRecord<T extends Row>(
  record: T,
  format: OutputFormat,
  options: { id: (record: T) => string },
): void {
  if (format === "json") return write(JSON.stringify(record, null, 2));
  if (format === "ids") return write(options.id(record));
  const keys = Object.keys(record);
  const width = Math.max(0, ...keys.map((k) => k.length));
  write(
    keys.map((k) => `${(k + ":").padEnd(width + 1)} ${cell(record[k])}`)
      .join("\n"),
  );
}
