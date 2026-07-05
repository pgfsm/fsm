import { getLogger } from "@logtape/logtape";
import {
  type ActorReference,
  DELAY_ACTION_NAME_PREFIX,
  isVersionFolderName,
} from "./util.ts";

const logger = getLogger(["@pgfsm/compiler", "scaffold"]);

/**
 * Languages an operation-logic module can be scaffolded in.
 * Aligns with the `fsmLanguage` enum on invoke objects and the actor folder
 * convention (`typescript/`, `python/`, `rust/`, `go/`).
 */
export type OperationLang = "typescript" | "python" | "rust" | "go";

export const SUPPORTED_OPERATION_LANGS: OperationLang[] = [
  "typescript",
  "python",
  "rust",
  "go",
];

export function isOperationLang(value: string): value is OperationLang {
  return (SUPPORTED_OPERATION_LANGS as string[]).includes(value);
}

/** The kind of operation logic being scaffolded. */
export type OperationKind = "actions" | "guards" | "delays" | "actors";

/** The index-module filename written for a given language. */
export function operationModuleFileName(lang: OperationLang): string {
  switch (lang) {
    case "typescript":
      return "index.ts";
    case "python":
      return "index.py";
    case "rust":
      return "mod.rs";
    case "go":
      return "index.go";
  }
}

/** The source-file extension for a given language. */
export function operationFileExtension(lang: OperationLang): string {
  switch (lang) {
    case "typescript":
      return "ts";
    case "python":
      return "py";
    case "rust":
      return "rs";
    case "go":
      return "go";
  }
}

/** Sanitizes a value for use as a filename component (keeps identifier chars). */
function sanitizeFileComponent(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function stub(lang: OperationLang, kind: OperationKind, name: string): string {
  // Delays are exposed under a prefixed function name; the comment keeps the
  // original name for readability.
  const fnName = kind === "delays"
    ? `${DELAY_ACTION_NAME_PREFIX}${name}`
    : name;
  const label = kind.slice(0, 1).toUpperCase() + kind.slice(1, -1); // Action/Guard/Delay/Actor
  const todo = kind === "actors"
    ? "TODO: implement actor logic"
    : kind === "delays"
    ? "TODO: implement delay logic (return ms)"
    : "TODO: implement";

  switch (lang) {
    case "typescript":
      if (kind === "guards") {
        return `// ${label}: ${name}\nexport function ${fnName}(context: any, event: any) {\n  // ${todo}\n  return true;\n}\n\n`;
      }
      if (kind === "delays") {
        return `// ${label}: ${name}\nexport function ${fnName}(context: any, event: any): number {\n  // ${todo}\n  return 0;\n}\n\n`;
      }
      return `// ${label}: ${name}\nexport function ${fnName}(context: any, event: any) {\n  // ${todo}\n}\n\n`;
    case "python":
      if (kind === "guards") {
        return `# ${label}: ${name}\ndef ${fnName}(context, event):\n    # ${todo}\n    return True\n\n`;
      }
      if (kind === "delays") {
        return `# ${label}: ${name}\ndef ${fnName}(context, event):\n    # ${todo}\n    return 0\n\n`;
      }
      return `# ${label}: ${name}\ndef ${fnName}(context, event):\n    # ${todo}\n    pass\n\n`;
    case "rust":
      if (kind === "guards") {
        return `// ${label}: ${name}\npub fn ${fnName}(context: &serde_json::Value, event: &serde_json::Value) -> bool {\n    // ${todo}\n    true\n}\n\n`;
      }
      if (kind === "delays") {
        return `// ${label}: ${name}\npub fn ${fnName}(context: &serde_json::Value, event: &serde_json::Value) -> u64 {\n    // ${todo}\n    0\n}\n\n`;
      }
      return `// ${label}: ${name}\npub fn ${fnName}(context: &serde_json::Value, event: &serde_json::Value) {\n    // ${todo}\n}\n\n`;
    case "go":
      if (kind === "guards") {
        return `// ${label}: ${name}\nfunc ${fnName}(context map[string]any, event map[string]any) bool {\n\t// ${todo}\n\treturn true\n}\n\n`;
      }
      if (kind === "delays") {
        return `// ${label}: ${name}\nfunc ${fnName}(context map[string]any, event map[string]any) int64 {\n\t// ${todo}\n\treturn 0\n}\n\n`;
      }
      return `// ${label}: ${name}\nfunc ${fnName}(context map[string]any, event map[string]any) {\n\t// ${todo}\n}\n\n`;
  }
}

/**
 * Renders the full index-module content for a set of operation-logic names in a
 * given language. Names are deduplicated. Go modules get a package header named
 * after the kind.
 */
export function renderOperationModule(
  lang: OperationLang,
  kind: OperationKind,
  names: string[],
): string {
  const unique = [...new Set(names)];
  let out = lang === "go" ? `package ${kind}\n\n` : "";
  for (const name of unique) {
    out += stub(lang, kind, name);
  }
  return out;
}

/**
 * Writes one operation-logic index module to `<absFolderPath>/<lang>/<kind>/`.
 */
export async function writeOperationModule(
  absFolderPath: string,
  lang: OperationLang,
  kind: OperationKind,
  names: string[],
): Promise<void> {
  const dir = `${absFolderPath}/${lang}/${kind}`;
  await Deno.mkdir(dir, { recursive: true });
  const file = `${dir}/${operationModuleFileName(lang)}`;
  await Deno.writeTextFile(file, renderOperationModule(lang, kind, names));
}

/**
 * Base filename (without extension) for a per-actor file:
 * `<fsmType>_<fsmVersion>_<src>`. fsmType/fsmVersion default when absent.
 */
export function actorFileBaseName(actor: ActorReference): string {
  const fsmType = sanitizeFileComponent(actor.fsmType ?? "promise");
  const fsmVersion = sanitizeFileComponent(actor.fsmVersion ?? "1");
  const src = sanitizeFileComponent(actor.src);
  return `${fsmType}_${fsmVersion}_${src}`;
}

/**
 * Writes a single actor to its own file at
 * `<absFolderPath>/<lang>/actors/<fsmType>_<fsmVersion>_<src>.<ext>`.
 * The file exports one function named after the actor `src`.
 * Returns the absolute path written.
 */
export async function writeActorFile(
  absFolderPath: string,
  lang: OperationLang,
  actor: ActorReference,
): Promise<string> {
  const dir = `${absFolderPath}/${lang}/actors`;
  await Deno.mkdir(dir, { recursive: true });
  const file = `${dir}/${actorFileBaseName(actor)}.${
    operationFileExtension(lang)
  }`;
  const header = lang === "go" ? "package actors\n\n" : "";
  await Deno.writeTextFile(file, header + stub(lang, "actors", actor.src));
  return file;
}

/**
 * Walks a plugin-root folder, finds every versioned FSM subdirectory (e.g.
 * `creditCheck/v01/`) that contains an `fsm.json`, and invokes `handler` with
 * the absolute version-folder path and the parsed fsm.json.
 */
export async function eachVersionedFsmFolder(
  folderPath: string,
  skipDirs: string[],
  handler: (absFolderPath: string, fsmData: unknown) => Promise<void>,
): Promise<void> {
  if (folderPath.startsWith(".")) {
    throw new Error(
      `Invalid folder path: ${folderPath}. Folder paths cannot start with '.'`,
    );
  }
  if (folderPath.endsWith("/")) {
    throw new Error(
      `Invalid folder path: ${folderPath}. Folder paths cannot end with '/'`,
    );
  }

  const absFolderPath = folderPath.startsWith("/")
    ? folderPath
    : `${Deno.cwd()}/${folderPath}`;

  for await (const dirEntry of Deno.readDir(absFolderPath)) {
    if (!dirEntry.isDirectory || skipDirs.includes(dirEntry.name)) continue;

    const fsmDirPath = `${absFolderPath}/${dirEntry.name}`;
    for await (const subEntry of Deno.readDir(fsmDirPath)) {
      if (!subEntry.isDirectory) continue;
      if (!isVersionFolderName(subEntry.name)) {
        logger.info("Skipping non-versioned folder: {name} in {dir}", {
          name: subEntry.name,
          dir: fsmDirPath,
        });
        continue;
      }

      const versionFolderPath = `${fsmDirPath}/${subEntry.name}`;
      const fsmJsonPath = `${versionFolderPath}/fsm.json`;
      try {
        const fsmData = JSON.parse(await Deno.readTextFile(fsmJsonPath));
        await handler(versionFolderPath, fsmData);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
          logger.info("fsm.json is missing in {path}", {
            path: versionFolderPath,
          });
        } else {
          logger.error("Failed to process {path}: {error}", {
            path: fsmJsonPath,
            error: err,
          });
        }
      }
    }
  }
}
