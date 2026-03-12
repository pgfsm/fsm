export interface DBDeps {
  useSupabase: boolean;
  db: any; // Replace with actual DB client type, e.g., PGClient
  // If using drizzle, you might want to specify the type accordingly
}
