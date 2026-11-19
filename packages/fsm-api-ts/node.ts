import { serve } from "@hono/node-server";
import { createSecureServer } from "node:http2";
import { readFileSync } from "node:fs";

import app from "./app.ts";

const server = serve({
  port: 3000, // You can change this to your desired port
  fetch: app.fetch,
  createServer: createSecureServer,
  serverOptions: {
    key: readFileSync("localhost-privkey.pem"),
    cert: readFileSync("localhost-cert.pem"),
  },
});

// graceful shutdown
process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  server.close((err) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    process.exit(0);
  });
});

// Global error handlers for uncaught exceptions and unhandled promise rejections
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  // Optionally, perform cleanup or alerting here
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
  // Optionally, perform cleanup or alerting here
});
