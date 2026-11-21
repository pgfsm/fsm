import { apiReference } from "@scalar/hono-api-reference";

import { LICENSE_URL, type LicenseNotice, licenseNotice } from "./license.ts";
import type { AppOpenAPI } from "./types.ts";

export default function configureOpenAPI(
  app: AppOpenAPI,
  basePath = "",
  notice: LicenseNotice = licenseNotice(),
) {
  const prefixed = basePath || "";
  const specUrl = `${prefixed}/openapi`;

  app.doc("/openapi", {
    openapi: "3.0.0",
    info: {
      version: "1.0.0",
      title: "FSM API",
      // SPEC-017: the API's licence and, for AGPL-3.0 §13, its source.
      license: { name: notice.license, url: LICENSE_URL },
    },
    externalDocs: { description: "Source code", url: notice.source },
    servers: [{ url: prefixed || "/" }],
  });

  app.get(
    "/docs",
    apiReference({
      theme: "kepler",
      layout: "classic",
      defaultHttpClient: { targetKey: "js", clientKey: "fetch" },
      // @scalar/hono-api-reference v0.9 takes `url` directly (the old
      // `spec: { url }` wrapper was removed).
      url: specUrl,
    }),
  );
}
