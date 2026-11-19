// fsm_core's migration chain in supabase/migrations/ (SPEC-016): the base
// install fsm_core--1.0.0 and the upgrade scripts fsm_core--<from>--<to>, in
// order and without gaps. Used by scripts/check-fsm-core-version.ts.

const root = new URL("../", import.meta.url);
const migrationsDir = new URL("supabase/migrations/", root);

/** Supabase-only setup migrations, not part of fsm_core's chain. */
const PRE_MIGRATIONS = [
  "20241218134623_pre_migrations_fsm_core_extension_prerequisites.sql",
  "20241218134632_pre_migrations_fsm_core_extension_init.sql",
];

export type Migration = { file: string; from: string | null; to: string };

/** `<ts>_fsm_core--1.0.0.sql` or `<ts>_fsm_core--2.2.1--2.2.2.sql`. */
export function parseMigration(file: string): Migration | null {
  const m = file.match(/^\d+_fsm_core--([\d.]+)(?:--([\d.]+))?\.sql$/);
  if (!m) return null;
  return m[2] === undefined
    ? { file, from: null, to: m[1] }
    : { file, from: m[1], to: m[2] };
}

/** The chain from the base install to the newest version, checked for gaps. */
export function migrationChain(files: string[]): Migration[] {
  const unknown = files.filter((f) =>
    !PRE_MIGRATIONS.includes(f) && parseMigration(f) === null
  );
  if (unknown.length > 0) {
    throw new Error(`Unrecognized migration file(s): ${unknown.join(", ")}`);
  }
  const chain = files.sort().map(parseMigration).filter((m) => m !== null);
  if (chain[0]?.from !== null) {
    throw new Error("The first fsm_core migration must be a base install");
  }
  for (let i = 1; i < chain.length; i++) {
    if (chain[i].from !== chain[i - 1].to) {
      throw new Error(
        `Gap in the migration chain: ${chain[i - 1].file} ends at ${
          chain[i - 1].to
        }, ${chain[i].file} starts at ${chain[i].from}`,
      );
    }
  }
  return chain;
}

/** The migration chain in supabase/migrations/, checked for gaps. */
export async function readMigrationChain(): Promise<Migration[]> {
  const files: string[] = [];
  for await (const e of Deno.readDir(migrationsDir)) {
    if (e.isFile && e.name.endsWith(".sql")) files.push(e.name);
  }
  return migrationChain(files);
}
