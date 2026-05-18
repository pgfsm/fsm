import { v4 as uuidv4 } from "uuid";
import { writeFileSync } from "node:fs";
import { isVersionFolderName, type WorkflowType, type ActorReference, extractFsmPluginRefs, RAISE_CANCEL, DELAY_ACTION_NAME_PREFIX } from "./util.ts";

// Helper: Generate language folders and create modules for each action/guard
async function generateLanguageFolders(
  basePath: string,
  lang: 'typescript' | 'python',
  actions: string[],
  guards: string[],
  delays: string[],
  actors: ActorReference[]
) {
  const actorNames = [...new Set(actors.map(a => a.src))];
  // 2.1 Create folders
  const actionsDir = `${basePath}/${lang}/actions`;
  const guardsDir = `${basePath}/${lang}/guards`;
  const delaysDir = `${basePath}/${lang}/delays`;
  const actorsDir = `${basePath}/${lang}/actors`;
  await Deno.mkdir(actionsDir, { recursive: true });
  await Deno.mkdir(guardsDir, { recursive: true });
  await Deno.mkdir(delaysDir, { recursive: true });
  await Deno.mkdir(actorsDir, { recursive: true });

  // 2.2 Create a single index file for actions, guards, delays, actors in each folder
  let actionsIndexContent = '';
  let guardsIndexContent = '';
  let delaysIndexContent = '';
  let actorsIndexContent = '';

  for (const action of actions) {
    if (RAISE_CANCEL.has(action)) continue;
    actionsIndexContent +=
      lang === 'typescript'
        ? `// Action: ${action}\nexport function ${action}(context: any, event: any) {\n  // TODO: implement\n}\n\n`
        : `# Action: ${action}\ndef ${action}(context, event):\n    # TODO: implement\n    pass\n\n`;
  }

  for (const guard of guards) {
    guardsIndexContent +=
      lang === 'typescript'
        ? `// Guard: ${guard}\nexport function ${guard}(context: any, event: any) {\n  // TODO: implement\n  return true;\n}\n\n`
        : `# Guard: ${guard}\ndef ${guard}(context, event):\n    # TODO: implement\n    return True\n\n`;
  }

  for (const delay of delays) {
    const delayFnName = `${DELAY_ACTION_NAME_PREFIX}${delay}`;
    delaysIndexContent +=
      lang === 'typescript'
        ? `// Delay: ${delay}\nexport function ${delayFnName}() {\n  // TODO: implement delay logic\n}\n\n`
        : `# Delay: ${delay}\ndef ${delayFnName}():\n    # TODO: implement delay logic\n    pass\n\n`;
  }

  for (const actor of actorNames) {
    actorsIndexContent +=
      lang === 'typescript'
        ? `// Actor: ${actor}\nexport function ${actor}(context: any, event: any) {\n  // TODO: implement actor logic\n}\n\n`
        : `# Actor: ${actor}\ndef ${actor}(context, event):\n    # TODO: implement actor logic\n    pass\n\n`;
  }

  const actionsIndexFile = lang === 'typescript' ? `${actionsDir}/index.ts` : `${actionsDir}/index.py`;
  const guardsIndexFile = lang === 'typescript' ? `${guardsDir}/index.ts` : `${guardsDir}/index.py`;
  const delaysIndexFile = lang === 'typescript' ? `${delaysDir}/index.ts` : `${delaysDir}/index.py`;
  const actorsIndexFile = lang === 'typescript' ? `${actorsDir}/index.ts` : `${actorsDir}/index.py`;
  await Deno.writeTextFile(actionsIndexFile, actionsIndexContent);
  await Deno.writeTextFile(guardsIndexFile, guardsIndexContent);
  await Deno.writeTextFile(delaysIndexFile, delaysIndexContent);
  await Deno.writeTextFile(actorsIndexFile, actorsIndexContent);
}


async function generateFsmPluginFromFolder(
  dirEntryName: string,
  dirEntryNameVersion: string,
  folderPath: string,
  absFolderPath: string,
  parentSource: string,
  workflowType: WorkflowType
) {
  
  const fsmJson = `${absFolderPath}/fsm.json`;
  try {
    await Deno.stat(fsmJson);
    // 1. Load fsm.json file
    const fsmData = JSON.parse(await Deno.readTextFile(fsmJson));

    // 1.1 Call fn to get all actions and guards from json file
    const { actions, guards, delays, actors } = extractFsmPluginRefs(fsmData);

    // 2. Call fn to generate folders/files for each language
    await generateLanguageFolders(absFolderPath, 'typescript', actions, guards, delays, actors);
    // await generateLanguageFolders(absFolderPath, 'python', actions, guards, delays, actors);

  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.log(`fsm.json is missing in ${absFolderPath}/${dirEntryName}`);
    } else {
      console.error(`Failed to import or process ${fsmJson}:`, err);
    }
  }


}


export async function generateFsmPluginFromFolders(
  folderPath: string,
  workflowType: WorkflowType,
  skipDirs: string[] = []
) {
  if (folderPath.startsWith(".")) {
    throw new Error(`Invalid folder path: ${folderPath}. Folder paths cannot start with '.'`);
  }
  if (folderPath.endsWith("/")) {
    throw new Error(`Invalid folder path: ${folderPath}. Folder paths cannot end with '/'`);
  }
  if (folderPath.startsWith("/")) {
    console.log(`Importing workflows from absolute path: ${folderPath}`);
  } else {
    console.log(`Importing workflows from relative path: ${folderPath} to ${Deno.cwd()}`);
  }
  const absFolderPath = folderPath.startsWith("/") ? folderPath : `${Deno.cwd()}/${folderPath}`;
  for await (const dirEntry of Deno.readDir(absFolderPath)) {
    if (dirEntry.isDirectory) {
      if (skipDirs.includes(dirEntry.name)) {
        continue;
      }
  

      const fsmDirPath = `${absFolderPath}/${dirEntry.name}`;

      for await (const subEntry of Deno.readDir(fsmDirPath)) {
          if (subEntry.isDirectory) {
            if (isVersionFolderName(subEntry.name)) {
              await generateFsmPluginFromFolder(dirEntry.name, subEntry.name, folderPath, `${fsmDirPath}/${subEntry.name}`, dirEntry.name, workflowType);
            }else {
              console.log(`Skipping non-versioned folder: ${subEntry.name} in ${fsmDirPath}`);
            }
          }
        }

    }
  }
}