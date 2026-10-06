import dotenv from "dotenv";
// @ts-types="@types/pg"
import { Pool } from "pg";
import { getLogger } from "@logtape/logtape";
import type { DBDeps } from "@pgfsm/db";
import { resolveProfile } from "./config.ts";
import { usageError } from "./exit.ts";
import { CTL_CATEGORY } from "./logger.ts";

const logger = getLogger([CTL_CATEGORY]);

/**
 * The Postgres URL for a DB-direct command (SPEC-009 §5), first match wins:
 *
 * 1. `--db-url`
 * 2. a profile chosen explicitly: `--profile`, else $PGFSM_PROFILE
 * 3. $PGFSM_DB_URL, else $DATABASE_URL (./.env is loaded first)
 * 4. the config's current profile (`pgfsmctl config use`)
 *
 * An explicitly chosen profile beats the env vars (the spec has env first)
 * because ./.env is auto-loaded: `--profile prod` inside a project would
 * otherwise silently hit the project's local DATABASE_URL.
 *
 * A profile's db_url gets its password from credentials.json.
 */
export async function resolveDbUrl(
  flags: { dbUrl?: string; profile?: string },
): Promise<string> {
  if (flags.dbUrl) return used("--db-url", flags.dbUrl);

  dotenv.config({ path: ".env" });
  const explicit = flags.profile ?? Deno.env.get("PGFSM_PROFILE");
  if (explicit) {
    const p = await resolveProfile(explicit);
    if (p?.profile.db_url) {
      return used(
        `profile ${p.name}`,
        withPassword(p.profile.db_url, p.secrets.db_password),
      );
    }
    throw usageError(
      `Profile ${
        JSON.stringify(explicit)
      } has no db_url (pgfsmctl config set ${explicit} --db-url <url>)`,
    );
  }

  for (const name of ["PGFSM_DB_URL", "DATABASE_URL"]) {
    const value = Deno.env.get(name);
    if (value) return used(`$${name}`, value);
  }

  const current = await resolveProfile(undefined);
  if (current?.profile.db_url) {
    return used(
      `profile ${current.name}`,
      withPassword(current.profile.db_url, current.secrets.db_password),
    );
  }

  throw usageError(
    "No database: pass --db-url, set PGFSM_DB_URL or DATABASE_URL (a ./.env is read), or select a profile with a db_url (pgfsmctl config set <name> --db-url <url>).",
  );
}

function used(source: string, url: string): string {
  logger.debug("Database from {source}", { source });
  return url;
}

function withPassword(dbUrl: string, password: string | undefined): string {
  if (!password) return dbUrl;
  const url = new URL(dbUrl);
  url.password = password;
  return url.toString();
}

/** The password embedded in a Postgres URL, if any. */
export function urlPassword(dbUrl: string): string | undefined {
  try {
    return new URL(dbUrl).password || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs `fn` with a single-connection Pool (one-shot commands never need
 * more — root CLAUDE.md #4) and always ends the Pool afterwards.
 */
export async function withPool<T>(
  connectionString: string,
  fn: (deps: DBDeps) => Promise<T>,
): Promise<T> {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    return await fn({ db: pool, useSupabase: false });
  } finally {
    await pool.end();
  }
}
