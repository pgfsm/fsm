// SPEC-017: the API reports its licence and where its source is (AGPL-3.0
// §13), on GET / and in the OpenAPI document. No database needed.
import { assertEquals } from "@std/assert";

import configureOpenAPI from "../lib/configure-open-api.ts";
import { createRouter } from "../lib/create-router.ts";
import {
  DEFAULT_SOURCE_URL,
  LICENSE_SPDX,
  LICENSE_URL,
  licenseNotice,
} from "../lib/license.ts";
import { createIndexRouter } from "../routes/index.route.ts";

Deno.test("GET / reports the licence and the default source URL", async () => {
  const res = await createIndexRouter().request("/");
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    message: "pgfsm API",
    license: "AGPL-3.0-only",
    source: "https://github.com/pgfsm/fsm",
  });
});

Deno.test("GET / reports a modified API's own source URL", async () => {
  const notice = licenseNotice("https://git.example.com/acme/pgfsm-fork");
  const res = await createIndexRouter(notice).request("/");
  assertEquals(
    (await res.json()).source,
    "https://git.example.com/acme/pgfsm-fork",
  );
});

Deno.test("the OpenAPI document carries the licence and the source URL", async () => {
  const app = createRouter();
  configureOpenAPI(
    app,
    "",
    licenseNotice("https://git.example.com/acme/pgfsm-fork"),
  );
  const doc = await (await app.request("/openapi")).json();
  assertEquals(doc.info.license, { name: LICENSE_SPDX, url: LICENSE_URL });
  assertEquals(doc.externalDocs, {
    description: "Source code",
    url: "https://git.example.com/acme/pgfsm-fork",
  });
});

Deno.test("the default notice is AGPL-3.0-only with the upstream source", () => {
  assertEquals(licenseNotice(), {
    license: "AGPL-3.0-only",
    source: DEFAULT_SOURCE_URL,
  });
});
