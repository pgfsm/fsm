import { honoLogger } from "@logtape/hono";
import type { MiddlewareHandler } from "hono";

// @logtape/hono provides an official Hono middleware that:
// - Logs HTTP access records (method, path, status, responseTime) via LogTape
// - `context.requestId` reads x-request-id from incoming headers (or generates
//   a UUID), writes it back in the response header, and calls LogTape's
//   withContext() so every log record emitted anywhere during the request
//   automatically carries requestId without explicit propagation.
export function logtapeLogger(): MiddlewareHandler {
  return honoLogger({
    // Route all HTTP access logs under @pgfsm/api so they share the same
    // configured sink as the rest of the app.
    category: ["@pgfsm/api", "http"],

    // Structured object per request — logged as:
    // "{method} {url} {status} - {responseTime} ms"
    // with method, path, status, responseTime, contentLength, userAgent,
    // referrer also available as structured properties on the log record.
    format: "structured-combined",

    // Per-request implicit context via withContext(): reads / generates
    // x-request-id and makes it available on every LogTape record emitted
    // during the request — including deep library and DB calls.
    context: {
      requestId: {
        headerNames: ["x-request-id"],
        responseHeader: "x-request-id",
      },
      include: ["requestId", "method", "path"],
    },

    skip: (c) => c.req.path === "/favicon.ico",
  });
}
