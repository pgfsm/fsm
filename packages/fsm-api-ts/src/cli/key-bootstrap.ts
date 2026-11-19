// `pgfsm-api key bootstrap` (SPEC-016, #689): creates the first admin API
// key, the one-off step between installing fsm_core and managing keys through
// /admin/keys (`pgfsmctl key …`). Like Supabase's service-role key it comes
// from the database side, so it runs once, as a login that can act as
// fsm_admin (the database owner, which the install makes a member of every
// fsm_* role), never as the API's own fsm_authenticator login.
// @ts-types="@types/pg"
import type { Pool } from "pg";
import {
  createApiKey,
  type CreatedApiKey,
  listApiKeys,
  withRole,
} from "@pgfsm/db";

export class KeyBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyBootstrapError";
  }
}

/**
 * Creates an admin key named `name`. Refuses while a live (unrevoked) admin
 * key exists, unless `force`: a second bootstrap is either a mistake or a
 * recovery, and recovery should be deliberate.
 */
export async function bootstrapAdminKey(
  pool: Pool,
  { name, force = false }: { name: string; force?: boolean },
): Promise<CreatedApiKey> {
  const deps = { db: pool, useSupabase: false };
  const { rows: [login] } = await pool.query<
    { login: string; can_admin: boolean }
  >(
    `SELECT session_user AS login,
            pg_has_role(session_user, 'fsm_admin', 'MEMBER') AS can_admin`,
  );
  if (!login.can_admin) {
    throw new KeyBootstrapError(
      `the database login ${login.login} can't act as fsm_admin: run key bootstrap as the database owner (the login that installed fsm_core), or GRANT fsm_admin TO ${login.login};`,
    );
  }

  return await withRole(deps, "fsm_admin", async (admin) => {
    const live = (await listApiKeys(admin)).filter((k) =>
      k.role === "fsm_admin" && k.revoked_at === null
    );
    if (live.length > 0 && !force) {
      throw new KeyBootstrapError(
        `an admin key already exists (${
          live.map((k) => `${k.name}, ${k.prefix}…`).join("; ")
        }): manage keys with \`pgfsmctl key create|list|revoke\`, or pass --force to create another`,
      );
    }
    try {
      return await createApiKey(admin, name, "fsm_admin");
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new KeyBootstrapError(
          `an API key named ${
            JSON.stringify(name)
          } exists: pass --name <another name>`,
        );
      }
      throw err;
    }
  });
}
