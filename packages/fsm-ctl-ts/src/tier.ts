import dotenv from "dotenv";
import { resolveProfile } from "./config.ts";
import { usageError } from "./exit.ts";

/**
 * Which transports a command may use (#663). `auto` is SPEC-009 §5's
 * resolution: the API when an API target resolves, DB-direct otherwise. `api`
 * pins a machine or profile to the API: anything that would connect to
 * Postgres is refused, `--db-url` included.
 */
export type Tier = "api" | "auto";
export const TIERS: readonly Tier[] = ["api", "auto"];

export function parseTier(value: string, where: string): Tier {
  if ((TIERS as readonly string[]).includes(value)) return value as Tier;
  throw usageError(
    `${where} must be one of ${TIERS.join(", ")}, got ${JSON.stringify(value)}`,
  );
}

/**
 * The tier, first one set wins: a profile chosen explicitly (`--profile` /
 * $PGFSM_PROFILE), then $PGFSM_TIER, then the current profile (only when no
 * profile was chosen). Unlike the URLs, an explicit profile without a `tier`
 * falls through to $PGFSM_TIER, so picking a profile can't silently unpin a
 * machine pinned by its environment; a profile can still say `tier: auto`.
 */
export async function resolveTier(
  flags: { profile?: string },
): Promise<{ tier: Tier; source: string }> {
  dotenv.config({ path: ".env" });
  const explicitName = flags.profile ?? Deno.env.get("PGFSM_PROFILE");
  if (explicitName) {
    const p = await resolveProfile(explicitName);
    if (p?.profile.tier) {
      return {
        tier: parseTier(p.profile.tier, `profile ${p.name}'s tier`),
        source: `profile ${p.name}`,
      };
    }
  }
  const env = Deno.env.get("PGFSM_TIER");
  if (env) {
    return { tier: parseTier(env, "$PGFSM_TIER"), source: "$PGFSM_TIER" };
  }
  if (!explicitName) {
    const current = await resolveProfile(undefined);
    if (current?.profile.tier) {
      return {
        tier: parseTier(current.profile.tier, `profile ${current.name}'s tier`),
        source: `profile ${current.name}`,
      };
    }
  }
  return { tier: "auto", source: "default" };
}

/** Throws (exit 2) when the tier is pinned to the API. */
export async function refuseDbIfApiOnly(
  flags: { profile?: string },
): Promise<void> {
  const { tier, source } = await resolveTier(flags);
  if (tier !== "api") return;
  throw usageError(
    `This command needs a database connection, which is refused: the tier is pinned to api (from ${source}), so --db-url, $PGFSM_DB_URL, $DATABASE_URL and profiles' db_url aren't used. ` +
      "Use the API (--url and --api-key, $PGFSM_URL and $PGFSM_API_KEY, or a profile's url and api key): fsm load|list|get and instance … support it. " +
      "DB-direct commands (db …, scheduler run) belong to a deploy job that isn't pinned (PGFSM_TIER=auto, or a profile with tier: auto).",
  );
}
