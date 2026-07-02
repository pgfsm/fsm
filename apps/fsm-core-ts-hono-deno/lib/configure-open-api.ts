import { apiReference } from "@scalar/hono-api-reference";

import type { AppOpenAPI } from "./types.ts";

export default function configureOpenAPI(app: AppOpenAPI, basePath = "") {
  const prefixed = basePath || "";
  const specUrl = `${prefixed}/openapi`;

  app.doc("/openapi", {
    openapi: "3.0.0",
    info: {
      version: "1.0.0",
      title: "FSM API",
    },
    servers: [{ url: prefixed || "/" }],
  });

  app.get("/docs", (c) => {
    return apiReference({
      theme: "kepler",
      layout: "classic",
      defaultHttpClient: { targetKey: "js", clientKey: "fetch" },
      spec: { url: specUrl },
    })(c);
  });
}
