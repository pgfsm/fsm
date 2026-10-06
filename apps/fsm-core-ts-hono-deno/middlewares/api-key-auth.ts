import type { MiddlewareHandler } from "hono";
import type { Pool } from "pg";
import { getLogger } from "@logtape/logtape";
import { type ApiKeyRole, hashApiKey, verifyApiKey, withRole } from "@pgfsm/db";
import { FORBIDDEN, UNAUTHORIZED } from "stoker/http-status-codes.ts";

const logger = getLogger(["@pgfsm/api", "auth"]);

export type ApiKeyAuthOptions = {
  /**
   * Pool that verifies keys and runs the request. Its login needs EXECUTE on
   * fsm_core.verify_api_key and membership in each role it serves:
   * fsm_authenticator (+ fsm_admin where the admin API is on), or the schema
   * owner in development (SPEC-009 §1).
   */
  pool: Pool;
  /**
   * Lowest role the route accepts. "fsm_operator" also accepts admin keys
   * (fsm_admin is a member of fsm_operator); "fsm_admin" accepts only them.
   */
  requiredRole: ApiKeyRole;
  /**
   * How long a verification result is reused, in ms. It's also the upper
   * bound on how long a revoked key keeps working. 0 disables the cache.
   */
  cacheTtlMs: number;
};

type CacheEntry = { role: ApiKeyRole | null; expiresAt: number };

/** Thrown inside withRole to roll back without changing the response. */
class RollbackRequest extends Error {}

/**
 * SPEC-009 §3. Reads `Authorization: Bearer <key>`, verifies the key's SHA-256
 * with fsm_core.verify_api_key, then runs the rest of the request inside
 * withRole(key's role): one transaction under SET LOCAL ROLE, with `db` set to
 * that transaction, so Postgres grants decide what the handler can do.
 *
 * - Missing or malformed header, unknown or revoked key → 401.
 * - An operator key on an admin route → 403.
 * - The transaction rolls back when the handler throws or answers 5xx, and
 *   commits otherwise.
 */
export function apiKeyAuth(options: ApiKeyAuthOptions): MiddlewareHandler {
  const { pool, requiredRole, cacheTtlMs } = options;
  const cache = new Map<string, CacheEntry>();

  const verify = async (keyHash: string): Promise<ApiKeyRole | null> => {
    const now = Date.now();
    const hit = cache.get(keyHash);
    if (hit && hit.expiresAt > now) return hit.role;
    const role = await verifyApiKey({ db: pool, useSupabase: false }, keyHash);
    if (cacheTtlMs > 0) {
      cache.set(keyHash, { role, expiresAt: now + cacheTtlMs });
      // Keep the map bounded: drop expired entries now and then.
      if (cache.size > 1000) {
        for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
      }
    }
    return role;
  };

  return async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (!match) {
      return c.json(
        { message: "Missing API key: send Authorization: Bearer <key>" },
        UNAUTHORIZED,
      );
    }

    const role = await verify(await hashApiKey(match[1]));
    if (!role) {
      return c.json({ message: "Invalid or revoked API key" }, UNAUTHORIZED);
    }
    if (requiredRole === "fsm_admin" && role !== "fsm_admin") {
      return c.json({ message: "This route needs an admin key" }, FORBIDDEN);
    }

    c.set("role", role);
    try {
      await withRole({ db: pool, useSupabase: false }, role, async (deps) => {
        c.set("db", deps.db);
        await next();
        // Hono turns a handler's throw into c.error + an onError response
        // without rejecting next(), so check both before committing.
        if (c.error || c.res.status >= 500) throw new RollbackRequest();
      });
    } catch (error) {
      if (error instanceof RollbackRequest) return; // response already set
      logger.error("Request transaction failed: {error}", { error });
      throw error;
    }
  };
}
