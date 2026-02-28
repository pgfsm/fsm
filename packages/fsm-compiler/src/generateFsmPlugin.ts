import { v4 as uuidv4 } from "uuid";
import { writeFileSync } from "node:fs";



async function generateFsmPluginFromFolder(
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
    const { actions, guards, delays, actors } = getActionsAndGuardsFromFsmJson(fsmData);

    // 2. Call fn to generate folders/files for each language
    await generateLanguageFolders(absFolderPath, 'typescript', actions, guards, delays, actors);
    await generateLanguageFolders(absFolderPath, 'python', actions, guards, delays, actors);

  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.log(`fsm.json is missing in ${absFolderPath}/${dirEntryName}`);
    } else {
      console.error(`Failed to import or process ${fsmJson}:`, err);
    }
  }
// Helper: Extract actions and guards from FSM JSON
function getActionsAndGuardsFromFsmJson(fsmData: any): { actions: string[]; guards: string[]; delays: string[]; actors: string[] } {
  // Recursively traverse the FSM JSON to collect all action, guard, delay, and actor names
  const actionsSet = new Set<string>();
  const guardsSet = new Set<string>();
  const delaysSet = new Set<string>();
  const actorsSet = new Set<string>();

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

    // Collect actions, guards, delays from transitions (in 'on' and 'transitions')
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
            // Guards
            if (transition.guard && typeof transition.guard === 'string') {
              guardsSet.add(transition.guard);
            }
            // Delays
            if (transition.delay && typeof transition.delay === 'string') {
              delaysSet.add(transition.delay);
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
        // Guards
        if (transition.guard && typeof transition.guard === 'string') {
          guardsSet.add(transition.guard);
        }
        // Delays
        if (transition.delay && typeof transition.delay === 'string') {
          delaysSet.add(transition.delay);
        }
      }
    }

    // Collect actors from invoke
    if (Array.isArray(state.invoke)) {
      for (const inv of state.invoke) {
        if (inv && typeof inv.src === 'string') {
          actorsSet.add(inv.src);
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
    delays: Array.from(delaysSet).filter(Boolean),
    actors: Array.from(actorsSet).filter(Boolean),
  };
}


// Helper: Generate language folders and create modules for each action/guard
async function generateLanguageFolders(
  basePath: string,
  lang: 'typescript' | 'python',
  actions: string[],
  guards: string[],
  delays: string[],
  actors: string[]
) {
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
    delaysIndexContent +=
      lang === 'typescript'
        ? `// Delay: ${delay}\nexport function ${delay}() {\n  // TODO: implement delay logic\n}\n\n`
        : `# Delay: ${delay}\ndef ${delay}():\n    # TODO: implement delay logic\n    pass\n\n`;
  }

  for (const actor of actors) {
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

}


export async function generateFsmPluginFromFolders(
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
             
              await generateFsmPluginFromFolder(dirEntry.name, subEntry.name, folderPath, `${fsmDirPath}/${subEntry.name}`, dirEntry.name, workflow_type);
            }else {
              console.log(`Skipping non-timestamped folder: ${subEntry.name} in ${fsmDirPath}`);
            }
          }
        }

    }
  }
}