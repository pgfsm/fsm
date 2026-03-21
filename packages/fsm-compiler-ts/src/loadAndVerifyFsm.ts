import { isVersionFolderName, type WorkflowType } from "./util.ts";
import { loadFsmFromJsonV2 } from "../../../apps/fsm-core-db-ts/src/fsm-helper.ts";
import { validateFsmPluginLoadFromFolder } from "./validateFsmPluginLoad.ts";

export interface FsmLoadResult {
  fsmName: string;
  fsmVersion: string;
  ok: boolean;
  cached: boolean;
  pluginVerified?: boolean;
  pluginFailedMethods?: { method: string; moduleType: string; modulePath: string }[];
  error?: string;
}

async function _loadAndVerifyFolder(
  fsmName: string,
  fsmVersion: string,
  absFolderPath: string,
  workflowType: string,
  deps: any,
): Promise<FsmLoadResult> {
  const fsmJsonPath = `${absFolderPath}/fsm.json`;
  const label = `[${workflowType}] ${fsmName}/${fsmVersion}`;
  try {
    await Deno.stat(fsmJsonPath);
    const fsmData = JSON.parse(await Deno.readTextFile(fsmJsonPath));
    const rootNodeText: string | null = (fsmData?.key ?? fsmData?.id) || null;

    const result = await loadFsmFromJsonV2(deps, fsmData, rootNodeText, fsmName, fsmVersion) as any;
    const ok: boolean = result?.ok === true;
    const cached: boolean = result?.cached === true;

    

    // DB load succeeded — now validate plugin modules
    const pluginResult = await validateFsmPluginLoadFromFolder(
      fsmName,
      fsmVersion,
      absFolderPath,
      absFolderPath,
      fsmName,
      workflowType,
    );
    const pluginVerified: boolean = pluginResult.fsmfsmModuleVerified;
    const pluginFailedMethods = pluginResult.resultValidateLanguageModules?.failedMethods ?? [];

    if (pluginVerified) {
      console.log(`${label}: ✓ loaded + verified${cached ? " (cached)" : ""}`);
    } else {
      console.warn(
        `${label}: ~ loaded, plugin not verified — failed: ${JSON.stringify(pluginFailedMethods)}`,
      );
    }
    return { fsmName, fsmVersion, ok, cached, pluginVerified, pluginFailedMethods };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.log(`${label}: fsm.json not found, skipping`);
      return { fsmName, fsmVersion, ok: false, cached: false, error: "fsm.json not found" };
    }
    console.error(`${label}: ✗ not loaded —`, err);
    return { fsmName, fsmVersion, ok: false, cached: false, error: String(err) };
  }
}

/**
 * Walks folderPath for <fsmName>/<version>/fsm.json trees, calls
 * load_fsm_from_json_v2 for each, and logs:
 *   ✓ loaded + verified   — DB fn returned ok=true
 *   ~ loaded, not verified — DB fn returned ok=false
 *   ✗ not loaded           — exception thrown
 */
export async function loadAndVerifyFsm(
  deps: any,
  folderPath: string,
  workflowType: WorkflowType = "fsm",
  skipDirs: string[] = [],
): Promise<FsmLoadResult[]> {
  if (folderPath.startsWith(".")) {
    throw new Error(`Invalid folder path: ${folderPath}. Paths cannot start with '.'`);
  }
  const absFolderPath = folderPath.startsWith("/")
    ? folderPath
    : `${Deno.cwd()}/${folderPath}`;

  const results: FsmLoadResult[] = [];

  for await (const dirEntry of Deno.readDir(absFolderPath)) {
    if (!dirEntry.isDirectory || skipDirs.includes(dirEntry.name)) continue;

    const fsmDirPath = `${absFolderPath}/${dirEntry.name}`;
    for await (const subEntry of Deno.readDir(fsmDirPath)) {
      if (!subEntry.isDirectory || !isVersionFolderName(subEntry.name)) continue;

      const result = await _loadAndVerifyFolder(
        dirEntry.name,
        subEntry.name,
        `${fsmDirPath}/${subEntry.name}`,
        workflowType,
        deps,
      );
      results.push(result);
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  console.log(`[${workflowType}] Load + verify complete: ${okCount}/${results.length} FSMs loaded`);
  return results;
}

/**
 * Returns a startup function that can be passed as the 3rd argument to createApp().
 * Binds folderPath and workflowType so the caller only needs to supply deps at runtime.
 *
 * @example
 *   createApp(pool, basePath, createFsmApp(FSM_EXAMPLE_FOLDER));
 */
export function createFsmApp(
  folderPath: string,
  workflowType: WorkflowType = "fsm",
  skipDirs: string[] = [],
): (deps: any) => Promise<FsmLoadResult[]> {
  return (deps: any) => loadAndVerifyFsm(deps, folderPath, workflowType, skipDirs);
}
