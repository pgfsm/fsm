// Compares fsm_core in two databases (SPEC-016, #688): every install form
// (plain SQL, CREATE EXTENSION) must produce the same fsm_core;
// compare-pgext-and-fullsqlscript.ts uses it. Exits 1 and prints the differences otherwise.
//
//   deno run --allow-net --allow-env scripts/compare-fsm-core-catalog.ts <url-a> <url-b>
//
// Compared: functions (definition, SECURITY DEFINER, config), tables with
// their columns, defaults, constraints and indexes, sequences, types, the
// grants on all of them (the owner written as <owner>, since the two installs
// can belong to different logins), the fsm_* roles' memberships, and the
// pg_cron job. Objects that belong to another extension are left out
// (Supabase's database also has pg_jsonschema's functions in fsm_core, which
// the full install doesn't create); the fsm_core extension's own members are
// compared, so the same script checks the PGXN form (CREATE EXTENSION
// fsm_core) against the full install.

// @ts-types="@types/pg"
import pg from "pg";

type Catalog = Record<string, string>;

/** Not a member of another extension (members of fsm_core itself, in its
 *  PGXN form, are compared like any other object). */
const NOT_EXTENSION_MEMBER = (classid: string, oid: string) =>
  `NOT EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
                WHERE d.classid = '${classid}'::regclass AND d.objid = ${oid}
                  AND d.deptype = 'e' AND e.extname <> 'fsm_core')`;

/** An ACL with the owner normalised, sorted, as one line. */
const ACL = (acl: string, owner: string) => `
  coalesce((SELECT string_agg(
      CASE WHEN a.grantee = ${owner} THEN '<owner>'
           WHEN a.grantee = 0 THEN 'PUBLIC'
           ELSE a.grantee::regrole::text END
      || '=' || a.privilege_type, ',' ORDER BY 1)
    FROM aclexplode(${acl}) a), '')`;

const QUERIES: Record<string, string> = {
  function: `
    SELECT p.oid::regprocedure::text AS key,
           md5(pg_get_functiondef(p.oid)) || ' definer=' || p.prosecdef
             || ' config=' || coalesce(array_to_string(p.proconfig, ';'), '')
             || ' acl=' || ${
    ACL("coalesce(p.proacl, acldefault('f', p.proowner))", "p.proowner")
  } AS value
      FROM pg_proc p
     WHERE p.pronamespace = 'fsm_core'::regnamespace
       AND ${NOT_EXTENSION_MEMBER("pg_proc", "p.oid")}`,
  column: `
    SELECT c.relname || '.' || a.attname AS key,
           format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull
             || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') AS value
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE c.relnamespace = 'fsm_core'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm')
       AND a.attnum > 0 AND NOT a.attisdropped
       AND ${NOT_EXTENSION_MEMBER("pg_class", "c.oid")}`,
  relation: `
    SELECT c.relname AS key,
           c.relkind::text || ' acl=' || ${
    ACL("coalesce(c.relacl, acldefault('r', c.relowner))", "c.relowner")
  } AS value
      FROM pg_class c
     WHERE c.relnamespace = 'fsm_core'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
       AND ${NOT_EXTENSION_MEMBER("pg_class", "c.oid")}`,
  constraint: `
    SELECT conrelid::regclass::text || ' ' || conname AS key, pg_get_constraintdef(oid) AS value
      FROM pg_constraint
     WHERE connamespace = 'fsm_core'::regnamespace`,
  index: `
    SELECT indexname AS key, indexdef AS value
      FROM pg_indexes WHERE schemaname = 'fsm_core'`,
  type: `
    SELECT t.typname AS key,
           t.typtype::text || coalesce(' ' || (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
                                          FROM pg_enum e WHERE e.enumtypid = t.oid), '') AS value
      FROM pg_type t
     WHERE t.typnamespace = 'fsm_core'::regnamespace AND t.typtype IN ('e', 'c', 'd')
       AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype = t.oid AND c.relkind <> 'c')
       AND ${NOT_EXTENSION_MEMBER("pg_type", "t.oid")}`,
  role: `
    SELECT r.rolname AS key,
           'login=' || r.rolcanlogin || ' inherit=' || r.rolinherit || ' member_of='
             || coalesce((SELECT string_agg(g.rolname, ',' ORDER BY g.rolname)
                            FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                           WHERE m.member = r.oid AND g.rolname LIKE 'fsm\\_%'), '') AS value
      FROM pg_roles r WHERE r.rolname LIKE 'fsm\\_%'`,
  cron: `
    SELECT jobname AS key, schedule || ' ' || command || ' active=' || active AS value
      FROM cron.job WHERE jobname = 'fsm_schedule_all_pending'`,
};

export async function describe(url: string): Promise<Catalog> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const catalog: Catalog = {};
    for (const [kind, sql] of Object.entries(QUERIES)) {
      const { rows } = await client.query<{ key: string; value: string }>(sql);
      for (const r of rows) catalog[`${kind} ${r.key}`] = r.value;
    }
    return catalog;
  } finally {
    await client.end();
  }
}

export function diff(a: Catalog, b: Catalog): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const out: string[] = [];
  for (const k of keys) {
    if (!(k in b)) out.push(`only in A: ${k}`);
    else if (!(k in a)) out.push(`only in B: ${k}`);
    else if (a[k] !== b[k]) {
      out.push(`differs: ${k}\n  A: ${a[k]}\n  B: ${b[k]}`);
    }
  }
  return out;
}

if (import.meta.main) {
  const [a, b] = Deno.args;
  if (!a || !b) {
    console.error("usage: compare-fsm-core-catalog.ts <url-a> <url-b>");
    Deno.exit(2);
  }
  const [ca, cb] = await Promise.all([describe(a), describe(b)]);
  const problems = diff(ca, cb);
  if (problems.length > 0) {
    console.error(
      `fsm_core differs (${problems.length}):\n${problems.join("\n")}`,
    );
    Deno.exit(1);
  }
  console.log(
    `fsm_core is the same in both databases (${
      Object.keys(ca).length
    } objects).`,
  );
}
