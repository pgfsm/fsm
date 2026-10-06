import type { ApiKeyRole } from "@pgfsm/db";
import { usageError } from "./exit.ts";

/** `--role admin|operator` (or the full fsm_admin/fsm_operator) → the role. */
export function parseKeyRole(value: unknown, help: string): ApiKeyRole {
  switch (value) {
    case "admin":
    case "fsm_admin":
      return "fsm_admin";
    case "operator":
    case "fsm_operator":
      return "fsm_operator";
    case undefined:
      throw usageError("--role is required: admin or operator", help);
    default:
      throw usageError(
        `--role must be admin or operator, got: ${String(value)}`,
        help,
      );
  }
}

export const KEY_ONCE_WARNING =
  "Store this key now: it is shown only this once (only its hash is kept).";
