import { getLogger } from "@logtape/logtape";
import type { Pool, PoolClient } from "pg";
import type { DBDeps } from "../custom.types.ts";

const logger = getLogger(["@pgfsm/db", "access-control"]);

/**
 * The fsm_core roles a caller can switch to (SPEC-009 §1). fsm_authenticator
 * is the API's login, not a role to switch to.
 */
export type FsmDbRole = "fsm_operator" | "fsm_admin" | "fsm_worker";

export const FSM_DB_ROLES: readonly FsmDbRole[] = [
  "fsm_operator",
  "fsm_admin",
  "fsm_worker",
];

/**
 * Runs `fn` as `role`: one connection, `BEGIN; SET LOCAL ROLE <role>; …;
 * COMMIT` (ROLLBACK on error). `SET LOCAL` ends with the transaction, so the
 * connection goes back to the pool with its login role, and it's safe behind
 * a transaction-mode pooler.
 *
 * `fn` gets `deps` whose `db` runs every query on that connection. A wrapper
 * that opens its own transaction (`db.connect()` + BEGIN/COMMIT, e.g.
 * `loadFsmDefinitions`) still works: inside `withRole` its BEGIN, COMMIT and
 * ROLLBACK become a savepoint, its release() is a no-op, and its work commits
 * or rolls back with the outer transaction.
 *
 * Only `query()` and `connect()` are available on that `db`, and queries
 * share one connection, so `fn` must not run transactions concurrently.
 *
 * `role` must be one of {@linkcode FSM_DB_ROLES}; it's checked against that
 * list and never interpolated from anything else.
 */
export async function withRole<T>(
  deps: DBDeps,
  role: FsmDbRole,
  fn: (deps: DBDeps) => Promise<T>,
): Promise<T> {
  if (!FSM_DB_ROLES.includes(role)) {
    throw new Error(
      `withRole: unknown role ${JSON.stringify(role)} (expected one of ${
        FSM_DB_ROLES.join(", ")
      })`,
    );
  }

  const client = await deps.db.connect();
  let destroy = false;
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    const result = await fn({ ...deps, db: roleScopedPool(client) });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch((rollbackError) => {
      // The connection's state is unknown; don't hand it back to the pool.
      destroy = true;
      logger.warn("withRole: ROLLBACK failed: {error}", {
        error: rollbackError,
      });
    });
    throw error;
  } finally {
    client.release(destroy);
  }
}

const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;?\s*$/i;

let savepointCounter = 0;

/** A Pool stand-in whose queries all run on `client` (see withRole). */
function roleScopedPool(client: PoolClient): Pool {
  // deno-lint-ignore no-explicit-any
  const query = (...args: any[]) => (client.query as any)(...args);
  const connect = () => {
    const savepoint = `pgfsm_with_role_${++savepointCounter}`;
    // deno-lint-ignore no-explicit-any
    const nestedQuery = (text: any, ...rest: any[]) => {
      const control = typeof text === "string"
        ? TRANSACTION_CONTROL.exec(text)?.[1].toUpperCase()
        : undefined;
      switch (control) {
        case "BEGIN":
          return client.query(`SAVEPOINT ${savepoint}`);
        case "COMMIT":
          return client.query(`RELEASE SAVEPOINT ${savepoint}`);
        case "ROLLBACK":
          return client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        default:
          return query(text, ...rest);
      }
    };
    return Promise.resolve({ query: nestedQuery, release: () => {} });
  };
  // Only query() and connect() are used by @pgfsm/db wrappers.
  return { query, connect } as unknown as Pool;
}
