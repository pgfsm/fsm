// SPEC-017: the gateway's licence notice (logged at startup, AGPL-3.0 §13).
import { assertEquals } from "@std/assert";
import {
  DEFAULT_SOURCE_URL,
  LICENSE_SPDX,
  licenseNotice,
} from "../src/license.ts";

Deno.test("licenseNotice defaults to AGPL-3.0-only and the upstream source", () => {
  assertEquals(LICENSE_SPDX, "AGPL-3.0-only");
  assertEquals(licenseNotice(), {
    license: "AGPL-3.0-only",
    source: DEFAULT_SOURCE_URL,
  });
  // An unset or empty PGFSM_SOURCE_URL means the upstream source.
  assertEquals(licenseNotice("").source, "https://github.com/pgfsm/fsm");
});

Deno.test("licenseNotice reports a modified gateway's own source", () => {
  assertEquals(
    licenseNotice("https://git.example.com/acme/pgfsm-fork").source,
    "https://git.example.com/acme/pgfsm-fork",
  );
});
