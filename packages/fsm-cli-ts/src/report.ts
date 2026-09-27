import { relative, SEPARATOR } from "@std/path";
import type { FileWriteEvent } from "@pgfsm/compiler";

/**
 * Collects the compiler's per-file write events for one command run, one
 * entry per file: a command may write the same file more than once (create
 * lays down empty aggregates, then add rewrites them; a folder source
 * regenerates aggregates once per FSM). A file created earlier in the run
 * stays "created".
 */
export class WriteReport {
  readonly #byPath = new Map<string, FileWriteEvent>();
  /** Extra files the CLI itself wrote (pgfsm.config.json, package.json, ...). */
  readonly ownFiles: { path: string; action: "created" | "updated" }[] = [];

  readonly onFileWrite = (event: FileWriteEvent): void => {
    const earlier = this.#byPath.get(event.path);
    this.#byPath.set(
      event.path,
      earlier?.action === "created" ? { ...event, action: "created" } : event,
    );
  };

  get events(): FileWriteEvent[] {
    return [...this.#byPath.values()];
  }

  /** Rewrites event paths from a dry-run sandbox back onto the real root. */
  remap(fromRoot: string, toRoot: string): void {
    const events = this.events;
    this.#byPath.clear();
    for (const e of events) {
      const path = e.path.startsWith(fromRoot)
        ? toRoot + e.path.slice(fromRoot.length)
        : e.path;
      this.#byPath.set(path, { ...e, path });
    }
    for (const f of this.ownFiles) {
      if (f.path.startsWith(fromRoot)) {
        f.path = toRoot + f.path.slice(fromRoot.length);
      }
    }
  }
}

const SYMBOL = { created: "+", regenerated: "~", kept: "=" } as const;

/** `sync-worker/typescript`, `async-worker/python`, `fsm/checkout/v01`, or the top-level entry. */
function areaOf(rel: string): string {
  const parts = rel.split(SEPARATOR);
  if (parts[0] === "sync-worker" || parts[0] === "async-worker") {
    return parts.slice(0, 2).join("/");
  }
  if (parts[0] === "fsm") return parts.slice(0, 3).join("/");
  return "project";
}

/**
 * Renders the +created / ~regenerated / =kept summary SPEC-004 asks for,
 * one line per area, then the created files, then any kept stub modules
 * missing exports the FSMs now need.
 */
export function formatReport(report: WriteReport, root: string): string {
  const lines: string[] = [];
  const byArea = new Map<string, Record<keyof typeof SYMBOL, number>>();
  const bump = (area: string, action: keyof typeof SYMBOL) => {
    const counts = byArea.get(area) ?? { created: 0, regenerated: 0, kept: 0 };
    counts[action]++;
    byArea.set(area, counts);
  };
  for (const f of report.ownFiles) {
    bump("project", f.action === "created" ? "created" : "regenerated");
  }
  for (const e of report.events) bump(areaOf(relative(root, e.path)), e.action);

  const width = Math.max(0, ...[...byArea.keys()].map((a) => a.length));
  for (const [area, c] of [...byArea].sort(([a], [b]) => a.localeCompare(b))) {
    const parts = (Object.keys(SYMBOL) as (keyof typeof SYMBOL)[])
      .filter((k) => c[k] > 0)
      .map((k) => `${SYMBOL[k]}${c[k]} ${k}`);
    lines.push(`  ${area.padEnd(width)}  ${parts.join("  ")}`);
  }

  const missing = report.events.filter((e) => e.missingNames?.length);
  if (missing.length > 0) {
    lines.push("", "Kept your stub files, but they're missing exports:");
    for (const e of missing) {
      lines.push(
        `  ${relative(root, e.path)}: add ${e.missingNames!.join(", ")}`,
      );
    }
  }
  return lines.join("\n");
}
