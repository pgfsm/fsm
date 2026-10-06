import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { resolveProfile } from "./config.ts";
import { usageError } from "./exit.ts";
import { CTL_CATEGORY } from "./logger.ts";

const logger = getLogger([CTL_CATEGORY]);

/** A pgfsm REST API and the key to call it with (SPEC-009 §5). */
export type ApiTarget = { url: string; apiKey: string; source: string };

/**
 * The API target, resolved like resolveDbUrl, each part on its own (first
 * match wins):
 *
 * - URL: `--url` → $PGFSM_URL → current profile
 * - key: `--api-key` → $PGFSM_API_KEY → current profile (keys live in
 *   credentials.json, set with `config set --api-key-stdin`)
 *
 * A profile chosen explicitly (`--profile` / $PGFSM_PROFILE) replaces both
 * the env and the current profile: only the flags and that profile count, so
 * picking a DB-only profile can't be overridden by a stray $PGFSM_URL.
 *
 * `url` is the API's base URL including its path prefix, e.g.
 * http://localhost:9999/fsm. Returns undefined when no URL resolves (so a
 * command that has a DB-direct fallback can use it); throws when a URL
 * resolves without a key.
 */
export async function resolveApiTarget(
  flags: { url?: string; apiKey?: string; profile?: string },
): Promise<ApiTarget | undefined> {
  dotenv.config({ path: ".env" });
  const explicitName = flags.profile ?? Deno.env.get("PGFSM_PROFILE");
  const explicit = explicitName
    ? await resolveProfile(explicitName)
    : undefined;
  const current = explicitName ? undefined : await resolveProfile(undefined);

  const pick = (
    choices: [string, string | undefined][],
  ): [string, string] | undefined => {
    for (const [source, value] of choices) {
      if (value) return [source, value];
    }
    return undefined;
  };

  const env = (name: string) => explicit ? undefined : Deno.env.get(name);
  const url = pick([
    ["--url", flags.url],
    [`profile ${explicit?.name}`, explicit?.profile.url],
    ["$PGFSM_URL", env("PGFSM_URL")],
    [`profile ${current?.name}`, current?.profile.url],
  ]);
  if (!url) return undefined;

  const key = pick([
    ["--api-key", flags.apiKey],
    [`profile ${explicit?.name}`, explicit?.secrets.api_key],
    ["$PGFSM_API_KEY", env("PGFSM_API_KEY")],
    [`profile ${current?.name}`, current?.secrets.api_key],
  ]);
  if (!key) {
    throw usageError(
      `An API URL is set (from ${
        url[0]
      }) but no API key: pass --api-key, set PGFSM_API_KEY, or store one with \`config set <profile> --api-key-stdin\`.`,
    );
  }

  const source = url[0] === key[0] ? url[0] : `${url[0]} + key from ${key[0]}`;
  logger.debug("API from {source}", { source });
  return { url: url[1].replace(/\/+$/, ""), apiKey: key[1], source };
}
