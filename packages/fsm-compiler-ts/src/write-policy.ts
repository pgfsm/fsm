import { AsyncLocalStorage } from "node:async_hooks";
import { isNotFoundError } from "./util.ts";

/**
 * How a run treats files that already exist (#381, SPEC-004 "File ownership
 * rule"):
 *
 * - `"all"` (default) — rewrite every file, the compiler's historical
 *   behaviour.
 * - `"generated-only"` — rewrite {@linkcode FileClass} `"generated"` files, but
 *   leave an existing `"scaffolded"` file untouched. This is what
 *   `@pgfsm/cli` uses, so re-running never destroys a developer's code.
 */
export type OverwriteMode = "all" | "generated-only";

/**
 * - `"generated"` — compiler-owned: fsm.json, registries, manifests, barrels,
 *   aggregates, and the Go worker module (its `go.mod` lists every actor).
 *   Always rewritten.
 * - `"scaffolded"` — written once for the developer to own: action/guard/delay
 *   and actor stubs, per-actor Go `go.mod`s, the TS/Python/Rust worker entry
 *   files and their `deno.json`/`pyproject.toml`/`Cargo.toml`, `.gitignore`s.
 */
export type FileClass = "generated" | "scaffolded";

/** What a single write did. `"kept"` means an existing scaffolded file was left untouched. */
export type FileWriteAction = "created" | "regenerated" | "kept";

export interface FileWriteEvent {
  /** Absolute path. */
  path: string;
  fileClass: FileClass;
  action: FileWriteAction;
  /**
   * Only for a kept stub module: identifiers the FSM now needs that the
   * existing file doesn't mention, for the developer to add by hand.
   */
  missingNames?: string[];
}

export interface WritePolicyOptions {
  /** Defaults to `"all"`. */
  overwrite?: OverwriteMode;
  /** Called once per file this run creates, regenerates, or keeps. */
  onFileWrite?: (event: FileWriteEvent) => void;
}

interface WritePolicyState {
  overwrite: OverwriteMode;
  onFileWrite?: (event: FileWriteEvent) => void;
  /** Paths kept this run, so best-effort formatters can skip them. */
  kept: Set<string>;
}

const storage = new AsyncLocalStorage<WritePolicyState>();

function current(): WritePolicyState {
  return storage.getStore() ?? { overwrite: "all", kept: new Set() };
}

/**
 * Runs `fn` with `options` applied to every {@linkcode writeOwnedFile} call
 * inside it. Nested calls inherit the outer policy for any option they leave
 * undefined, so `generateAll` can pass its options down without every inner
 * entry point overriding them.
 */
export function withWritePolicy<T>(
  options: WritePolicyOptions | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const outer = storage.getStore();
  const state: WritePolicyState = {
    overwrite: options?.overwrite ?? outer?.overwrite ?? "all",
    onFileWrite: options?.onFileWrite ?? outer?.onFileWrite,
    kept: outer?.kept ?? new Set(),
  };
  return storage.run(state, fn);
}

/** Drops paths kept this run -- for best-effort formatters, which must never touch a developer's file. */
export function withoutKept(paths: string[]): string[] {
  const { kept } = current();
  return paths.filter((p) => !kept.has(p));
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (isNotFoundError(err)) return undefined;
    throw err;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The single write path for every file the compiler emits, applying the
 * current {@linkcode OverwriteMode}. `requiredNames` (stub modules only) are
 * the identifiers the file must define; when an existing scaffolded file is
 * kept, any of them it doesn't mention are reported as `missingNames`.
 */
export async function writeOwnedFile(
  path: string,
  content: string,
  fileClass: FileClass,
  requiredNames: string[] = [],
): Promise<FileWriteAction> {
  const state = current();
  const existing = await readIfExists(path);

  if (
    existing !== undefined && fileClass === "scaffolded" &&
    state.overwrite === "generated-only"
  ) {
    state.kept.add(path);
    const missingNames = requiredNames.filter((name) =>
      !new RegExp(`(^|[^\\w$])${escapeRegExp(name)}($|[^\\w$])`).test(
        existing,
      )
    );
    state.onFileWrite?.({
      path,
      fileClass,
      action: "kept",
      ...(missingNames.length > 0 && { missingNames }),
    });
    return "kept";
  }

  await Deno.writeTextFile(path, content);
  const action: FileWriteAction = existing === undefined
    ? "created"
    : "regenerated";
  state.onFileWrite?.({ path, fileClass, action });
  return action;
}
