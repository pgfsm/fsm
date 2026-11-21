// SPEC-017: every generated fsm_core SQL artifact starts with the AGPL-3.0-only
// licence header, exactly once.
import { assert, assertEquals } from "@std/assert";
import { SQL_LICENSE_HEADER, withPrerequisites } from "./prerequisites-sql.ts";

const fullScript = SQL_LICENSE_HEADER +
  "-- fsm_core 9.9.9: full SQL\nSELECT 1;\n";

Deno.test("the licence header declares AGPL-3.0-only", () => {
  const lines = SQL_LICENSE_HEADER.split("\n");
  // REUSE-IgnoreStart (a string literal, not this file's licence tag)
  assertEquals(lines[1], "-- SPDX-License-Identifier: AGPL-3.0-only");
  // REUSE-IgnoreEnd
});

Deno.test("the plain-SQL install starts with the header, once", () => {
  const sql = withPrerequisites(
    "9.9.9",
    fullScript,
    "all-output/fsm_core--9.9.9.sql",
  );
  assert(sql.startsWith(SQL_LICENSE_HEADER));
  assertEquals(sql.split("SPDX-License-Identifier").length - 1, 1);
  assert(sql.includes("SELECT 1;"));
});
