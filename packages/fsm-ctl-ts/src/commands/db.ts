import dotenv from "dotenv";
import { Pool } from "pg";
import { getLogger } from "@logtape/logtape";
import type { DBDeps } from "@pgfsm/db";
import { CTL_CATEGORY } from "../logger.ts";

const logger = getLogger([CTL_CATEGORY]);

/**
 * --db-url, else DATABASE_URL (loading ./.env first). Exits when neither is
 * set: every pgfsmctl command needs a database, and none needs a pgfsm
 * project (SPEC-005).
 */
export function resolveDbUrl(dbUrlFlag: string | undefined): string {
  dotenv.config({ path: ".env" });
  const url = dbUrlFlag ?? Deno.env.get("DATABASE_URL") ?? "";
  if (!url) {
    logger.error("DATABASE_URL is required (set in .env or pass --db-url)");
    Deno.exit(1);
  }
  return url;
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
