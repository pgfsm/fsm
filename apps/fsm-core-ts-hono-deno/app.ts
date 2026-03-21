// apps/host/app.ts
import { Hono } from "hono";
import { Pool } from "pg";
import createApp from "../fsm-core-ts-hono-deno/lib/create-app.ts";
import { createFsmApp } from "../../packages/fsm-compiler-ts/src/loadAndVerifyFsm.ts";

const FSM_EXAMPLE_FOLDER = new URL(
  "../fsm-core-example/fsm",
  import.meta.url,
).pathname;
const FSM_WORKFLOW_TYPE = "fsm" as const;
const FSM_SKIP_DIRS: string[] = [];
const FSM_SHARED_EXAMPLE_FOLDER = new URL(
  "../fsm-core-example/sharedFSM",
  import.meta.url,
).pathname;
const FSM_SHARED_WORKFLOW_TYPE = "sharedfsm" as const;
const FSM_SHARED_SKIP_DIRS: string[] = [];


const host = new Hono();

// Wire your own pool (or omit if you only use Supabase bindings)
const pool = new Pool({
  connectionString: Deno.env.get("DATABASE_URL"),
});

const urlPathPrefix = "/embedded"; // Adjust this if your FSM router is mounted at a different path
// Build the FSM router; pass createFsmApp so FSMs are loaded + verified on startup
const fsmRouter = createApp(
  pool,
  urlPathPrefix,
  createFsmApp(FSM_EXAMPLE_FOLDER, FSM_WORKFLOW_TYPE, FSM_SKIP_DIRS),
  createFsmApp(FSM_SHARED_EXAMPLE_FOLDER, FSM_SHARED_WORKFLOW_TYPE, FSM_SHARED_SKIP_DIRS),
);

// Mount it wherever you need
host.route(urlPathPrefix, fsmRouter);

export default host;
