import { assert, assertEquals } from "@std/assert";
import { withUpgradeScriptPreamble } from "../supabase-restart-with-diff.ts";
import { firstStatement } from "./check-fsm-core-version.ts";
import { SQL_LICENSE_HEADER } from "./prerequisites-sql.ts";

const v = { from: "1.2.0", to: "1.2.1" };
const diff =
  "create or replace function fsm_core.f() returns int as $$ select 1 $$ language sql;\n";

Deno.test("an upgrade script starts with the licence header, then require_version", () => {
  const sql = withUpgradeScriptPreamble(diff, "fsm_core", v);
  assert(sql.startsWith(SQL_LICENSE_HEADER));
  assertEquals(
    firstStatement(sql),
    "SELECT fsm_core.require_version('1.2.0');",
  );
  assert(sql.endsWith(diff));
});

Deno.test("re-running adds nothing", () => {
  const once = withUpgradeScriptPreamble(diff, "fsm_core", v);
  assertEquals(withUpgradeScriptPreamble(once, "fsm_core", v), once);
});

Deno.test("a script that already has require_version gets only the header", () => {
  const old = `SELECT fsm_core.require_version('1.2.0');\n\n${diff}`;
  const sql = withUpgradeScriptPreamble(old, "fsm_core", v);
  assertEquals(sql, SQL_LICENSE_HEADER + old);
});
