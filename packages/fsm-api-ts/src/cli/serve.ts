// The runtime-specific half of serving (SPEC-016, #689). Swapped for
// ./serve.node.ts in the npm build (build-npm.ts `mappings`): dnt's Deno shim
// has no Deno.serve, and Node has no global error events. The Deno-native
// default.
import { getLogger } from "@logtape/logtape";

export type FetchHandler = (request: Request) => Response | Promise<Response>;

export interface RunningServer {
  /** Stops accepting connections and waits for in-flight requests. */
  shutdown(): Promise<void>;
}

export function startServer(port: number, fetch: FetchHandler): RunningServer {
  const server = Deno.serve({ port }, fetch);
  return { shutdown: () => server.shutdown() };
}

/** Logs uncaught errors and unhandled rejections instead of exiting. */
export function logUncaught(): void {
  const logger = getLogger(["@pgfsm/api", "cli"]);
  globalThis.addEventListener("error", (event) => {
    logger.error("Uncaught exception: {error}", { error: event.error });
    event.preventDefault();
  });
  globalThis.addEventListener("unhandledrejection", (event) => {
    logger.error("Unhandled promise rejection: {reason}", {
      reason: event.reason,
    });
    event.preventDefault();
  });
}
