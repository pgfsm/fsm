import { parse, stringify } from "@std/yaml";
import { CtlError, ExitCode, notFound } from "./exit.ts";

// Named targets (SPEC-009 §5), dbosctl-style:
//
//   <config dir>/config.yaml       profiles: url and db_url, never secrets
//   <config dir>/credentials.json  per-profile api_key / db_password, mode 0600
//
// The config dir is $PGFSM_CONFIG_DIR, else the OS config directory:
// $XDG_CONFIG_HOME (or ~/.config) on Linux, ~/Library/Application Support on
// macOS, %APPDATA% on Windows, each with a `pgfsm` folder.

export type Profile = {
  /** pgfsm REST API base URL (SPEC-009 API tier; used from #473). */
  url?: string;
  /** Postgres URL for DB-direct commands, without its password. */
  db_url?: string;
};

export type ConfigFile = {
  current?: string;
  profiles: Record<string, Profile>;
};

export type ProfileSecrets = { api_key?: string; db_password?: string };
export type Credentials = { profiles: Record<string, ProfileSecrets> };

export function configDir(): string {
  const override = Deno.env.get("PGFSM_CONFIG_DIR");
  if (override) return override;
  const env = (k: string) => Deno.env.get(k);
  const home = env("HOME") ?? env("USERPROFILE") ?? ".";
  switch (Deno.build.os) {
    case "windows":
      return `${env("APPDATA") ?? `${home}/AppData/Roaming`}/pgfsm`;
    case "darwin":
      return `${home}/Library/Application Support/pgfsm`;
    default:
      return `${env("XDG_CONFIG_HOME") ?? `${home}/.config`}/pgfsm`;
  }
}

export const configPath = () => `${configDir()}/config.yaml`;
export const credentialsPath = () => `${configDir()}/credentials.json`;

async function readText(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
}

const malformed = (path: string, why: string) =>
  new CtlError(ExitCode.GENERAL, `${path} is malformed: ${why}`);

export async function readConfig(): Promise<ConfigFile> {
  const path = configPath();
  const text = await readText(path);
  if (text === undefined || text.trim() === "") return { profiles: {} };
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw malformed(path, (err as Error).message);
  }
  if (!doc || typeof doc !== "object") throw malformed(path, "not a mapping");
  const { current, profiles = {} } = doc as Partial<ConfigFile>;
  if (typeof profiles !== "object" || profiles === null) {
    throw malformed(path, "`profiles` is not a mapping");
  }
  return { ...(current ? { current } : {}), profiles };
}

export async function writeConfig(config: ConfigFile): Promise<void> {
  await Deno.mkdir(configDir(), { recursive: true });
  await Deno.writeTextFile(
    configPath(),
    "# pgfsmctl profiles. No secrets here: API keys and database passwords\n" +
      "# live in credentials.json next to this file (mode 0600).\n" +
      stringify(config),
  );
}

export async function readCredentials(): Promise<Credentials> {
  const path = credentialsPath();
  const text = await readText(path);
  if (text === undefined || text.trim() === "") return { profiles: {} };
  try {
    const doc = JSON.parse(text) as Partial<Credentials>;
    return { profiles: doc.profiles ?? {} };
  } catch (err) {
    throw malformed(path, (err as Error).message);
  }
}

export async function writeCredentials(creds: Credentials): Promise<void> {
  await Deno.mkdir(configDir(), { recursive: true });
  const path = credentialsPath();
  // `mode` only applies when the file is created, so chmod an existing one
  // too. Windows has no POSIX modes; there the file inherits the profile
  // directory's ACL.
  await Deno.writeTextFile(path, JSON.stringify(creds, null, 2) + "\n", {
    mode: 0o600,
  });
  if (Deno.build.os !== "windows") await Deno.chmod(path, 0o600);
}

/**
 * The profile a command uses: `--profile`, else $PGFSM_PROFILE, else the
 * config's `current`. Undefined when none is set. A name that was asked for
 * but doesn't exist is an error (exit 4).
 */
export async function resolveProfile(
  flag: string | undefined,
): Promise<
  { name: string; profile: Profile; secrets: ProfileSecrets } | undefined
> {
  const config = await readConfig();
  const name = flag ?? Deno.env.get("PGFSM_PROFILE") ?? config.current;
  if (!name) return undefined;
  const profile = config.profiles[name];
  if (!profile) {
    throw notFound(
      `No profile named ${JSON.stringify(name)} in ${configPath()}`,
    );
  }
  const secrets = (await readCredentials()).profiles[name] ?? {};
  return { name, profile, secrets };
}
