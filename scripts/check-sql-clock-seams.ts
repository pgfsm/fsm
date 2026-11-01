// Fails if fsm_core SQL reads the clock directly instead of through
// fsm_core.tx_now() / fsm_core.wall_now() (SPEC-015 §2, #642).
//
// Why: the deterministic simulator runs the real SQL on virtual time by setting
// the fsm_core.sim_now GUC, which only the seams read. One raw now() (a lease
// stamp, a heartbeat, a staleness check) puts real time back into a simulated
// run, and the run stops being a function of its seed.
//
// Checked: every SQL file under packages/database-src/supabase/schemas/, and
// the SQL @pgfsm/db sends inline (packages/fsm-core-db-ts/src/). Not checked:
// the seam definitions themselves, the vendored pgmq source (commented-out
// reference; the pgmq that runs is the installed extension, which the sim
// database build rewrites, SPEC-015 (b)), and generated migrations.
//
// Usage: deno run --allow-read --allow-run=git scripts/check-sql-clock-seams.ts [files…]
// With no files (CI), checks every tracked file in scope; prek passes the staged ones.

const SCHEMAS = "packages/database-src/supabase/schemas/";
const DB_CLIENT = "packages/fsm-core-db-ts/src/";
const EXEMPT = new Set([
  "packages/database-src/supabase/schemas/10_ext_helper/20261031120000_fsm_core_clock.sql",
  "packages/database-src/supabase/schemas/00_pre_ext/20241218134622_PGMQ_source.sql",
]);

// Function-call forms. The lookbehind skips Date.now() / performance.now() and
// identifiers that merely end in "now", e.g. tx_now().
const CALL =
  /(?<![.\w])(now|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday)\s*\(/gi;
// SQL-standard keyword forms, and the 'now' literal ('now'::timestamptz).
const KEYWORD =
  /\b(current_timestamp|current_time|localtimestamp|localtime)\b|'now'/gi;

function inScope(file: string): boolean {
  if (EXEMPT.has(file)) return false;
  return (file.startsWith(SCHEMAS) && file.endsWith(".sql")) ||
    (file.startsWith(DB_CLIENT) && file.endsWith(".ts"));
}

/** Drops comments so a commented-out now() doesn't count. */
function stripComments(line: string, isTs: boolean): string {
  const trimmed = line.trimStart();
  if (isTs && (trimmed.startsWith("//") || trimmed.startsWith("*"))) return "";
  return line.replace(/--.*$/, "");
}

/** 1-based line numbers and the matched text of raw clock reads in `text`. */
export function rawClockReads(
  text: string,
  isTs: boolean,
): { line: number; match: string }[] {
  const found: { line: number; match: string }[] = [];
  let inBlockComment = false;
  text.split("\n").forEach((raw, i) => {
    let line = raw;
    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end < 0) return;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    line = line.replace(/\/\*.*?\*\//g, "");
    const start = line.indexOf("/*");
    if (start >= 0) {
      line = line.slice(0, start);
      inBlockComment = true;
    }
    line = stripComments(line, isTs);
    for (const m of [...line.matchAll(CALL), ...line.matchAll(KEYWORD)]) {
      found.push({ line: i + 1, match: m[0] });
    }
  });
  return found;
}

async function trackedFiles(): Promise<string[]> {
  const { stdout } = await new Deno.Command("git", {
    args: ["ls-files", SCHEMAS, DB_CLIENT],
  }).output();
  return new TextDecoder().decode(stdout).split("\n").filter(Boolean);
}

if (import.meta.main) {
  const files = (Deno.args.length > 0 ? Deno.args : await trackedFiles())
    .filter(inScope);
  const problems: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await Deno.readTextFile(file);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) continue; // deleted in this commit
      throw err;
    }
    for (const { line, match } of rawClockReads(text, file.endsWith(".ts"))) {
      problems.push(`${file}:${line}  ${match}`);
    }
  }
  if (problems.length > 0) {
    console.error(
      `fsm_core SQL reads the clock directly (SPEC-015, #642):\n` +
        problems.map((p) => `  ${p}`).join("\n") +
        `\nUse fsm_core.tx_now() for now() / current_timestamp, and ` +
        `fsm_core.wall_now() for clock_timestamp(), or simulated runs see real time.`,
    );
    Deno.exit(1);
  }
}
