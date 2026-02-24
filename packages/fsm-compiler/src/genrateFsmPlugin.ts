import { v4 as uuidv4 } from "uuid";
import { writeFileSync } from "node:fs";



async function genrateFsmPluginFromFolder(
  dirEntryName: string,
  dirEntryNameVersion: string,
  folderPath: string,
  absFolderPath: string,
  parentSource: string,
  workflow_type: "fsm" | "childfsm" | "sharedfsm" | "promise"
) {
  
  const fsmJson = `${absFolderPath}/fsm.json`;
  try {
    await Deno.stat(fsmJson);
    // 1. Load fsm.json file
    const fsmData = JSON.parse(await Deno.readTextFile(fsmJson));

    // 1.1 Call fn to get all actions and guards from json file
    const { actions, guards } = getActionsAndGuardsFromFsmJson(fsmData);

    // 2. Call fn to generate folders/files for each language
    await generateLanguageFolders(absFolderPath, 'typescript', actions, guards);
    await generateLanguageFolders(absFolderPath, 'python', actions, guards);

  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.log(`fsm.json is missing in ${absFolderPath}/${dirEntryName}`);
    } else {
      console.error(`Failed to import or process ${fsmJson}:`, err);
    }
  }
// Helper: Extract actions and guards from FSM JSON
function getActionsAndGuardsFromFsmJson(fsmData: any): { actions: string[]; guards: string[] } {
  // Recursively traverse the FSM JSON to collect all action and guard names
  const actionsSet = new Set<string>();
  const guardsSet = new Set<string>();

  function visitState(state: any) {
    // Collect actions from entry/exit arrays
    if (Array.isArray(state.entry)) {
      for (const entry of state.entry) {
        if (typeof entry === 'string') {
          actionsSet.add(entry);
        } else if (entry && typeof entry === 'object' && typeof entry.type === 'string') {
          actionsSet.add(entry.type);
        }
      }
    }
    if (Array.isArray(state.exit)) {
      for (const exit of state.exit) {
        if (typeof exit === 'string') {
          actionsSet.add(exit);
        } else if (exit && typeof exit === 'object' && typeof exit.type === 'string') {
          actionsSet.add(exit.type);
        }
      }
    }

    // Collect actions and guards from transitions (in 'on' and 'transitions')
    if (state.on && typeof state.on === 'object') {
      for (const eventKey of Object.keys(state.on)) {
        const transitions = state.on[eventKey];
        if (Array.isArray(transitions)) {
          for (const transition of transitions) {
            // Actions
            if (Array.isArray(transition.actions)) {
              for (const action of transition.actions) {
                if (typeof action === 'string') {
                  actionsSet.add(action);
                } else if (action && typeof action === 'object' && typeof action.type === 'string') {
                  actionsSet.add(action.type);
                }
              }
            }

            // cond: not using for now.
            // if (transition.cond) {
            //   if (typeof transition.cond === 'string') {
            //     guardsSet.add(transition.cond);
            //   } else if (transition.cond && typeof transition.cond === 'object' && typeof transition.cond.type === 'string') {
            //     guardsSet.add(transition.cond.type);
            //   }
            // }

            // Guards
            if (transition.guard && typeof transition.guard === 'string') {
              guardsSet.add(transition.guard);
            }
          }
        }
      }
    }
    if (Array.isArray(state.transitions)) {
      for (const transition of state.transitions) {
        // Actions
        if (Array.isArray(transition.actions)) {
          for (const action of transition.actions) {
            if (typeof action === 'string') {
              actionsSet.add(action);
            } else if (action && typeof action === 'object' && typeof action.type === 'string') {
              actionsSet.add(action.type);
            }
          }
        }

        // cond: not using for now.
        // if (transition.cond) {
        //   if (typeof transition.cond === 'string') {
        //     guardsSet.add(transition.cond);
        //   } else if (transition.cond && typeof transition.cond === 'object' && typeof transition.cond.type === 'string') {
        //     guardsSet.add(transition.cond.type);
        //   }
        // }

        // Guards
        if (transition.guard && typeof transition.guard === 'string') {
          guardsSet.add(transition.guard);
        }
      }
    }

    // Recursively visit substates
    if (state.states && typeof state.states === 'object') {
      for (const subKey of Object.keys(state.states)) {
        visitState(state.states[subKey]);
      }
    }
  }

  visitState(fsmData);
  return {
    actions: Array.from(actionsSet).filter(Boolean),
    guards: Array.from(guardsSet).filter(Boolean),
  };
}


// Helper: Generate language folders and create modules for each action/guard
async function generateLanguageFolders(
  basePath: string,
  lang: 'typescript' | 'python',
  actions: string[],
  guards: string[]
) {
  // 2.1 Create folders
  const actionsDir = `${basePath}/${lang}/actions`;
  const guardsDir = `${basePath}/${lang}/guards`;
  await Deno.mkdir(actionsDir, { recursive: true });
  await Deno.mkdir(guardsDir, { recursive: true });

  // 2.2 Create a single index file for actions and guards in each folder
  let actionsIndexContent = '';
  let guardsIndexContent = '';

  for (const action of actions) {
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

  const actionsIndexFile = lang === 'typescript' ? `${actionsDir}/index.ts` : `${actionsDir}/index.py`;
  const guardsIndexFile = lang === 'typescript' ? `${guardsDir}/index.ts` : `${guardsDir}/index.py`;
  await Deno.writeTextFile(actionsIndexFile, actionsIndexContent);
  await Deno.writeTextFile(guardsIndexFile, guardsIndexContent);
}

}


export async function genrateFsmPluginFromFolders(
  folderPath: string,
  workflow_type: "fsm" | "childfsm" | "sharedfsm" | "promise"
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
      if (dirEntry.name === "promise" || dirEntry.name === "sharedFSM") {
        continue;
      }
  

      const fsmDirPath = `${absFolderPath}/${dirEntry.name}`;

      for await (const subEntry of Deno.readDir(fsmDirPath)) {
          if (subEntry.isDirectory) {
            // check if subEntry name matches timestamp pattern YYYYMMDDHHMMSS
            const timestampPattern = /^\d{14}$/;
            if (timestampPattern.test(subEntry.name)) {
             
              await genrateFsmPluginFromFolder(dirEntry.name, subEntry.name, folderPath, `${fsmDirPath}/${subEntry.name}`, dirEntry.name, workflow_type);
            }else {
              console.log(`Skipping non-timestamped folder: ${subEntry.name} in ${fsmDirPath}`);
            }
          }
        }

    }
  }
}