// npm/Node variant of ./serve.ts (build-npm.ts `mappings`): @hono/node-server
// instead of Deno.serve, and process events instead of global error events.
import { serve } from "@hono/node-server";
import { getLogger } from "@logtape/logtape";
import process from "node:process";

export type FetchHandler = (request: Request) => Response | Promise<Response>;

export interface RunningServer {
  shutdown(): Promise<void>;
}

export function startServer(port: number, fetch: FetchHandler): RunningServer {
  const server = serve({ fetch, port });
  return {
    shutdown: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err?: Error) => (err ? reject(err) : resolve()))
      ),
  };
}

export function logUncaught(): void {
  const logger = getLogger(["@pgfsm/api", "cli"]);
  process.on("uncaughtException", (error: unknown) => {
    logger.error("Uncaught exception: {error}", { error });
  });
  process.on("unhandledRejection", (reason: unknown) => {
    logger.error("Unhandled promise rejection: {reason}", { reason });
  });
}
