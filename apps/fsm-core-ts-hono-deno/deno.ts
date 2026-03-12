import app from "./app.ts";
import env from "./env.ts";
// import { pool  } from "../fsm-core-db/src/pg-client.ts";

// app.route("/", (c) => {
//   return c.json({ message: "Hello World" });
// });

if (typeof Deno !== "undefined") {
  
  // pool.on("connect", () => {
  //   console.log("Database on connect event");
  //   // Deno.serve({ port: env.PORT }, app.fetch);
  // });
  // pool.on("acquire", () => {
  //   console.log("Database on acquired event");
  //   console.log("number of clients in the pool:", pool.totalCount);
  //   console.log("number of idle clients in the pool:", pool.idleCount);
  //   console.log("number of waiting requests in the pool:", pool.waitingCount);
  // });
  // pool.on("error", (err) => {
  //   console.error("Database error event:", err);
  // });

  // pool.connect().then(() => {
  //   console.log("Database connection established");
  //   Deno.serve({ port: env.PORT }, app.fetch);
     
  // }).catch((err) => {
  //   console.error("Database connection error:", err);
  // });
  Deno.serve({ port: env.PORT }, app.fetch);
 
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
