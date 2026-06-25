import { getLogger } from "@logtape/logtape";
import { configureApiLogger } from "./logger.ts";
import app from "./app.ts";
import env from "./env.ts";

const logger = getLogger(["@pgfsm/api", "deno"]);
await configureApiLogger();

if (typeof Deno !== "undefined") {
  Deno.serve({ port: env.PORT }, app.fetch);
}

self.addEventListener("error", (event) => {
  logger.error("Uncaught exception: {error}", { error: event.error });
  event.preventDefault();
});

self.addEventListener("unhandledrejection", (event) => {
  logger.error("Unhandled promise rejection: {reason}", { reason: event.reason });
  event.preventDefault();
});
