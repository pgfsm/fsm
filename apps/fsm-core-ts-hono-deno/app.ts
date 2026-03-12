// apps/host/app.ts
import { Hono } from "hono";
import { Pool } from "pg";
import createFsmApp from "../fsm-core-ts-hono-deno/lib/create-app.ts";

const host = new Hono();

// Wire your own pool (or omit if you only use Supabase bindings)
const pool = new Pool({
  connectionString: Deno.env.get("DATABASE_URL"),
});

const urlPathPrefix = "/embedded"; // Adjust this if your FSM router is mounted at a different path
// Build the FSM router; you can also pass custom CORS origin/dbType flags
const fsmRouter = createFsmApp(pool, urlPathPrefix);

// Mount it wherever you need
host.route(urlPathPrefix, fsmRouter);



export default host;
