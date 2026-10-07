// @ts-types="@types/pg"
import type { Pool } from "pg";

export interface DBDeps {
  useSupabase: boolean;
  db: Pool;
}
