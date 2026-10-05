import type { DBDeps } from "../custom.types.ts";
import { FSM_SCHEMA } from "../const.ts";

// API keys (SPEC-009 §2). fsm_core.api_keys stores only sha256(key) and a
// display prefix; the plaintext is returned once, by createApiKey().

const CREATE_API_KEY_FN = `${FSM_SCHEMA}.create_api_key`;
const REVOKE_API_KEY_FN = `${FSM_SCHEMA}.revoke_api_key`;
const LIST_API_KEYS_FN = `${FSM_SCHEMA}.list_api_keys`;
const VERIFY_API_KEY_FN = `${FSM_SCHEMA}.verify_api_key`;

/** The roles an API key can carry. */
export type ApiKeyRole = "fsm_admin" | "fsm_operator";

export const API_KEY_ROLES: readonly ApiKeyRole[] = [
  "fsm_admin",
  "fsm_operator",
];

/** createApiKey's result. `key` is the only copy of the plaintext. */
export type CreatedApiKey = {
  id: string;
  name: string;
  role: ApiKeyRole;
  prefix: string;
  key: string;
};

/** One row of list_api_keys(); never includes the hash. */
export type ApiKeyRow = {
  id: string;
  name: string;
  role: ApiKeyRole;
  prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
};

/**
 * Thin wrapper around fsm_core.create_api_key(). Needs fsm_admin (or the
 * schema owner, for the bootstrap key).
 */
export async function createApiKey(
  deps: DBDeps,
  name: string,
  role: ApiKeyRole,
): Promise<CreatedApiKey> {
  const res = await deps.db.query<{ result: CreatedApiKey }>(
    `SELECT ${CREATE_API_KEY_FN}($1::text, $2::text) AS result`,
    [name, role],
  );
  return res.rows[0].result;
}

/**
 * Thin wrapper around fsm_core.revoke_api_key(). `idOrName` matches a key's
 * id or its name. Returns true if a live key was revoked, false if none
 * matched or it was already revoked.
 */
export async function revokeApiKey(
  deps: DBDeps,
  idOrName: string,
): Promise<boolean> {
  const res = await deps.db.query<{ revoked: boolean }>(
    `SELECT ${REVOKE_API_KEY_FN}($1::text) AS revoked`,
    [idOrName],
  );
  return res.rows[0].revoked;
}

/** Thin wrapper around fsm_core.list_api_keys(): every key, newest first. */
export async function listApiKeys(deps: DBDeps): Promise<ApiKeyRow[]> {
  const res = await deps.db.query<ApiKeyRow>(
    `SELECT * FROM ${LIST_API_KEYS_FN}()`,
  );
  return res.rows;
}

/**
 * Thin wrapper around fsm_core.verify_api_key(): the role of the live key
 * whose SHA-256 is `keyHashHex` (from {@linkcode hashApiKey}), or null when
 * the key is unknown or revoked. Needs fsm_authenticator (or the owner).
 */
export async function verifyApiKey(
  deps: DBDeps,
  keyHashHex: string,
): Promise<ApiKeyRole | null> {
  const res = await deps.db.query<{ role: ApiKeyRole | null }>(
    `SELECT ${VERIFY_API_KEY_FN}(decode($1::text, 'hex')) AS role`,
    [keyHashHex],
  );
  return res.rows[0]?.role ?? null;
}

/**
 * SHA-256 of a plaintext API key, as lowercase hex — what fsm_core.api_keys
 * stores and {@linkcode verifyApiKey} takes. Hashing happens client-side so
 * the plaintext never reaches the database after creation, and a caller can
 * cache verification results by hash.
 */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
