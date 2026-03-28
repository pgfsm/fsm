import { resolveStateValue } from "@fsm/db";
import { replaceUnderscoresWithSpaces, replaceSpacesWithUnderscores } from "@fsm/compiler";
import { Pool } from "pg";

export { replaceUnderscoresWithSpaces, replaceSpacesWithUnderscores };

const pool = new Pool({
  connectionString: Deno.env.get("DATABASE_URL"),
});

export const dbDeps = {
  useSupabase: false,
  db: pool,
};

export { resolveStateValue };

// Tests comparing macrostep_v2 with xstate initialTransition/transition have moved to:
// ./compare_fsm_macrostep_2.ts
