import { basename, dirname, join, resolve } from "@std/path";
import { isNotFoundError, isVersionFolderName } from "@pgfsm/compiler";

export type SourceKind = "machine.ts" | "fsm.json";

/** One FSM version to add, with its identity already resolved. */
export interface ResolvedSource {
  /** Absolute path to the machine.ts or fsm.json. */
  path: string;
  kind: SourceKind;
  name: string;
  version: string;
}

export interface IdentityFlags {
  name?: string;
  version?: string;
}

/**
 * Asks the developer for a value no flag or path provided. `undefined` means
 * "not interactive" -- the caller then fails and names the flag instead.
 */
export type Ask = (question: string) => Promise<string | undefined>;

const FSM_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

export class SourceError extends Error {}

function kindOf(path: string): SourceKind | undefined {
  if (path.endsWith(".json")) return "fsm.json";
  if (path.endsWith(".ts")) return "machine.ts";
  return undefined;
}

async function statOrUndefined(path: string) {
  try {
    return await Deno.stat(path);
  } catch (err) {
    if (isNotFoundError(err)) return undefined;
    throw err;
  }
}

/**
 * What the file's own location says, when it sits at the conventional
 * `<fsmName>/<vNN>/` depth -- and only then. `-f a/fsm.json` must not turn
 * into name "<cwd>", version "a" (#372), so the version folder has to look
 * like one (`v01`).
 */
function identityFromPath(path: string): IdentityFlags {
  const versionDir = dirname(path);
  const version = basename(versionDir);
  if (!isVersionFolderName(version)) return {};
  const name = basename(dirname(versionDir));
  return FSM_NAME_RE.test(name) ? { name, version } : { version };
}

/** A usable name from fsm.json's own `id` -- xstate's default `(machine)` doesn't count. */
async function nameFromFsmJson(path: string): Promise<string | undefined> {
  try {
    const id = JSON.parse(await Deno.readTextFile(path))?.id;
    return typeof id === "string" && FSM_NAME_RE.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

async function resolveIdentity(
  path: string,
  kind: SourceKind,
  flags: IdentityFlags,
  ask: Ask,
): Promise<{ name: string; version: string }> {
  const fromPath = identityFromPath(path);
  let name = flags.name ?? fromPath.name ??
    (kind === "fsm.json" ? await nameFromFsmJson(path) : undefined);
  let version = flags.version ?? fromPath.version;

  if (!name) {
    name = (await ask(`FSM name for ${path}:`))?.trim() || undefined;
  }
  if (!version) {
    version = (await ask(`FSM version for ${path} (e.g. v01):`))?.trim() ||
      undefined;
  }
  const missing = [
    ...(name ? [] : ["--fsm-name"]),
    ...(version ? [] : ["--fsm-version"]),
  ];
  if (missing.length > 0) {
    throw new SourceError(
      `Can't tell the FSM ${
        missing.map((f) => f.slice(6)).join(" or ")
      } for ${path} from its folders -- pass ${missing.join(" and ")}.`,
    );
  }
  if (!FSM_NAME_RE.test(name!)) {
    throw new SourceError(
      `Invalid FSM name "${name}": use letters, digits, - or _, starting with a letter.`,
    );
  }
  if (!isVersionFolderName(version!)) {
    throw new SourceError(
      `Invalid FSM version "${version}": use v01, v02, ...`,
    );
  }
  return { name: name!, version: version! };
}

/**
 * Turns a `<source>` argument -- a folder, a machine.ts, or an fsm.json --
 * into the FSM versions to add. A folder is a plugin root
 * (`<fsmName>/<vNN>/{machine.ts|fsm.json}`), so identity always comes from
 * its folders; flags only apply to a single file. A version folder with both
 * files uses machine.ts, since fsm.json is compiled from it.
 */
export async function resolveSources(
  source: string,
  cwd: string,
  flags: IdentityFlags,
  ask: Ask,
): Promise<ResolvedSource[]> {
  const path = resolve(cwd, source);
  const stat = await statOrUndefined(path);
  if (!stat) throw new SourceError(`${source} does not exist`);

  if (stat.isFile) {
    const kind = kindOf(path);
    if (!kind) {
      throw new SourceError(
        `${source} must be a folder, a machine.ts, or an fsm.json`,
      );
    }
    return [{ path, kind, ...await resolveIdentity(path, kind, flags, ask) }];
  }

  if (flags.name || flags.version) {
    throw new SourceError(
      "--fsm-name/--fsm-version only apply to a single file; a folder's FSMs are named by their <fsmName>/<vNN>/ folders",
    );
  }
  const found: ResolvedSource[] = [];
  for await (const nameEntry of Deno.readDir(path)) {
    if (!nameEntry.isDirectory || !FSM_NAME_RE.test(nameEntry.name)) continue;
    for await (const versionEntry of Deno.readDir(join(path, nameEntry.name))) {
      if (
        !versionEntry.isDirectory || !isVersionFolderName(versionEntry.name)
      ) continue;
      const versionDir = join(path, nameEntry.name, versionEntry.name);
      for (const kind of ["machine.ts", "fsm.json"] as const) {
        const file = join(versionDir, kind);
        if (await statOrUndefined(file)) {
          found.push({
            path: file,
            kind,
            name: nameEntry.name,
            version: versionEntry.name,
          });
          break;
        }
      }
    }
  }
  if (found.length === 0) {
    throw new SourceError(
      `No FSMs found in ${source}: expected <fsmName>/<vNN>/machine.ts or fsm.json inside it`,
    );
  }
  return found.sort((a, b) =>
    a.name === b.name
      ? a.version.localeCompare(b.version)
      : a.name.localeCompare(b.name)
  );
}
