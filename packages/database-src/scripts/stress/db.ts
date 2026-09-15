import dotenv from "dotenv";
import { Pool } from "pg";

// Matches the pattern in packages/fsm-compiler-ts/src/load-fsm-json-test.ts:
// path is resolved relative to the deno task's cwd (packages/database-src),
// so this only works when invoked via `deno task stress` / `npm run stress`.
dotenv.config({ path: "../../.env" });

export function createPool(poolSize?: number): Pool {
  const connectionString = Deno.env.get("DATABASE_URL");
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Run via `npm run stress` / `deno task stress` " +
        "from packages/database-src with local Supabase running " +
        "(npm run supabase:start:env), or export DATABASE_URL yourself.",
    );
  }
  return new Pool({
    connectionString,
    max: poolSize ?? 10,
  });
}
