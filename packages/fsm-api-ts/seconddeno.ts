import app from "./app.ts";
import env from "./env.ts";

if (typeof Deno !== "undefined") {
  Deno.serve({ port: env.PORT + 1 }, app.fetch);
}
// Global error handler to prevent process exit on uncaught errors
self.addEventListener("error", (event) => {
  console.error("Uncaught exception:", event.error);
  event.preventDefault();
});

self.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection:", event.reason);
  event.preventDefault();
});

// this server is used to start second server of main app to test below
// 1. pg_try_advisory_lock or
// 2. custom lock_workflow_instance rpc function
// which are used to lock workflow instance in fsm-core
