// Type-checked by CI (not a test module): proves the @ts-types directive
// still gives `pg` its types on a fresh clone with no deno.lock (#479). If pg
// ever resolves as `any`, the @ts-expect-error below goes unused and
// `deno check` fails. scripts/check-pg-types-directive.ts makes sure every
// pg import carries the directive.
// @ts-types="@types/pg"
import { Pool } from "pg";

// @ts-expect-error connectionString is a string: only an error when pg is typed.
export const typedPgProbe = new Pool({ connectionString: 123 });
