import { getLogger } from "@logtape/logtape";
import { configureApiLogger } from "./logger.ts";
import env from "./env.ts";

// Must configure LogTape before app.ts is loaded — app.ts calls createApp()
// at module level (top-level await), which triggers bootstrapFsmModules() and
// emits logs before any sinks exist if we defer configure() until after import.
await configureApiLogger();

const { default: app } = await import("./app.ts");
const logger = getLogger(["@pgfsm/api", "deno"]);

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
