import { basename, join, resolve } from "@std/path";
import {
  FSM_DIR_NAME,
  generateAll,
  isNotFoundError,
  scaffoldWorkerProjects,
} from "@pgfsm/compiler";
import type { ProjectConfig } from "../project.ts";
import type { WriteReport } from "../report.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
}

export interface SyncResult {
  /** Entries whose recorded source is gone; their existing fsm.json was used. */
  sourceMissing: string[];
  /** Entries with neither a source nor an fsm.json left -- skipped. */
  skipped: string[];
}

/**
 * Regenerates every FSM the project tracks from its recorded source
 * (`pgfsm.config.json`'s `fsms[]`), after the developer edits a machine.ts or
 * fsm.json -- then re-lays the worker projects so all configured languages
 * stay present. Everything runs in `generated-only` mode: stubs and entry
 * files are never overwritten. A machine.ts's own id may legitimately change
 * between runs, so the compiler's machine-id guard is bypassed here.
 */
export async function syncProject(
  root: string,
  config: ProjectConfig,
  opts: { report: WriteReport; sourceRoot?: string },
): Promise<SyncResult> {
  const result: SyncResult = { sourceMissing: [], skipped: [] };
  for (const entry of config.fsms) {
    const id = `${entry.name}/${entry.version}`;
    const source = resolve(opts.sourceRoot ?? root, entry.source);
    const compiled = join(
      root,
      FSM_DIR_NAME,
      entry.name,
      entry.version,
      "fsm.json",
    );
    let folder = source;
    if (!(await exists(source))) {
      if (!(await exists(compiled))) {
        result.skipped.push(id);
        continue;
      }
      result.sourceMissing.push(id);
      folder = compiled;
    }
    await generateAll({
      folder,
      writeRootAbsPath: root,
      fsmName: entry.name,
      fsmVersion: entry.version,
      force: true,
      overwrite: "generated-only",
      onFileWrite: opts.report.onFileWrite,
    });
  }

  await scaffoldWorkerProjects({
    writeRootAbsPath: root,
    goModuleAppRoot: basename(opts.sourceRoot ?? root),
    asyncLangs: config.asyncWorkerLangs,
    projectName: config.name,
    overwrite: "generated-only",
    onFileWrite: opts.report.onFileWrite,
  });
  return result;
}
