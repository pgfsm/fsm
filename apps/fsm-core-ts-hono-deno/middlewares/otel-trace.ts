import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { MiddlewareHandler } from "hono";

const tracer = trace.getTracer("pgfsm-api");

export function otelTrace(): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    const path = c.req.path;

    await tracer.startActiveSpan(`${method} ${path}`, async (span) => {
      span.setAttributes({
        "http.request.method": method,
        "url.path": path,
      });

      try {
        await next();
        const route = c.req.routePath ?? path;
        span.updateName(`${method} ${route}`);
        span.setAttribute("http.route", route);
        span.setAttribute("http.response.status_code", c.res.status);
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (e) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
        throw e;
      } finally {
        span.end();
      }
    });
  };
}
